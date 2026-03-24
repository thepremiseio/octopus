/**
 * Vault Watcher — keeps the SQLite sharedspace_index in sync with the
 * filesystem vault. Uses chokidar for file watching with debounce.
 *
 * On startup, performs a full scan to reconcile the index with disk.
 * After that, watches for add/change/unlink events on .md files.
 */
import fs from 'fs';
import path from 'path';
import chokidar from 'chokidar';

import { VAULT_PATH } from './config.js';
import {
  upsertSharedspaceIndex,
  deleteSharedspaceIndex,
  pruneSharedspaceIndex,
} from './db.js';
import {
  readPageFromDisk,
  pageIdFromPath,
  invalidateAllAgentIndices,
  writePage,
} from './sharedspace.js';
import { broadcast } from './container-runner.js';
import { logger } from './logger.js';

// Debounce map: filePath → timeout handle
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 300;

/**
 * Index a single .md file into SQLite. Returns true if the file was indexed.
 */
function indexFile(filePath: string): boolean {
  const page = readPageFromDisk(filePath);
  if (!page) return false;

  upsertSharedspaceIndex({
    page_id: page.page_id,
    owner: page.owner,
    access: page.access,
    summary: page.summary,
    updated: page.updated,
    file_path: page.file_path,
  });
  return true;
}

/**
 * Remove a page from the index by its file path.
 */
function removeFromIndex(filePath: string): void {
  const pageId = pageIdFromPath(VAULT_PATH, filePath);
  deleteSharedspaceIndex(pageId);
}

/**
 * Create starter pages when the vault is first initialised.
 */
function createStarterPages(): void {
  writePage(
    'policies/hitl',
    {
      summary:
        'Wanneer agents menselijke goedkeuring moeten vragen voor ze handelen',
      owner: 'ceo',
      access: 'everyone',
      body: [
        '# HITL Goedkeuringsbeleid',
        '',
        'Agents moeten goedkeuring van de CEO vragen (`request_hitl` met type `approval`) voordat ze:',
        '',
        '- Externe communicatie versturen (e-mails, berichten naar externe diensten)',
        '- Aankopen doen of financiële verplichtingen aangaan',
        '- Gegevens verwijderen of archiveren die niet eenvoudig hersteld kunnen worden',
        '- Toegangsrechten of permissies wijzigen',
        '- Acties uitvoeren die moeilijk terug te draaien zijn',
        '',
        'Agents moeten `choice`-kaarten gebruiken wanneer ze meerdere geldige aanpakken hebben geïdentificeerd en input van de CEO willen over de richting.',
        '',
        'Agents moeten `fyi`-kaarten gebruiken voor statusupdates bij langlopend werk — deze zijn niet-blokkerend.',
      ].join('\n'),
    },
    'ceo',
  );
  logger.info('Created starter HITL policy page');
}

/**
 * Full scan: walk the vault directory and reconcile with the index.
 * - Index any .md files on disk that aren't in the index (or are stale)
 * - Remove index entries for files that no longer exist on disk
 */
function fullScan(): void {
  if (!fs.existsSync(VAULT_PATH)) {
    fs.mkdirSync(VAULT_PATH, { recursive: true });
    logger.info({ vault: VAULT_PATH }, 'Created vault directory');
  }

  // Seed starter pages if the vault has no .md files yet
  const hasPages = fs
    .readdirSync(VAULT_PATH, { recursive: true })
    .some((f) => String(f).endsWith('.md'));
  if (!hasPages) {
    createStarterPages();
  }

  // Walk vault for all .md files
  const diskPageIds = new Set<string>();

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const pageId = pageIdFromPath(VAULT_PATH, full);
        diskPageIds.add(pageId);
        indexFile(full);
      }
    }
  }

  walk(VAULT_PATH);

  // Prune index entries that no longer exist on disk
  pruneSharedspaceIndex(diskPageIds);

  invalidateAllAgentIndices();
  logger.info({ pages: diskPageIds.size }, 'Vault full scan complete');
}

/**
 * Handle a file add or change event (debounced).
 */
function handleAddOrChange(filePath: string): void {
  if (!filePath.endsWith('.md')) return;

  const prev = pending.get(filePath);
  if (prev) clearTimeout(prev);

  pending.set(
    filePath,
    setTimeout(() => {
      pending.delete(filePath);
      const indexed = indexFile(filePath);
      if (indexed) {
        invalidateAllAgentIndices();
        const pageId = pageIdFromPath(VAULT_PATH, filePath);
        const page = readPageFromDisk(filePath);
        broadcast('sharedspace.page.updated', {
          page_id: pageId,
          summary: page?.summary || '',
          owner_agent_id: page?.owner || 'ceo',
          updated_by_agent_id: 'filesystem',
          operation: 'updated',
        });
      }
    }, DEBOUNCE_MS),
  );
}

/**
 * Handle a file unlink event (debounced).
 */
function handleUnlink(filePath: string): void {
  if (!filePath.endsWith('.md')) return;

  const prev = pending.get(filePath);
  if (prev) clearTimeout(prev);

  pending.set(
    filePath,
    setTimeout(() => {
      pending.delete(filePath);
      const pageId = pageIdFromPath(VAULT_PATH, filePath);
      removeFromIndex(filePath);
      invalidateAllAgentIndices();
      broadcast('sharedspace.page.updated', {
        page_id: pageId,
        summary: '',
        owner_agent_id: 'unknown',
        updated_by_agent_id: 'filesystem',
        operation: 'deleted',
      });
    }, DEBOUNCE_MS),
  );
}

/**
 * Start the vault watcher. Call once at server startup after initDatabase().
 */
export function startVaultWatcher(): void {
  // Full scan to reconcile index with disk
  fullScan();

  // Watch for changes
  const watcher = chokidar.watch(VAULT_PATH, {
    ignoreInitial: true,
    persistent: true,
    depth: 10,
    ignored: /(^|[/\\])\../, // ignore dotfiles
  });

  watcher.on('add', handleAddOrChange);
  watcher.on('change', handleAddOrChange);
  watcher.on('unlink', handleUnlink);

  watcher.on('error', (err) => {
    logger.error({ err }, 'Vault watcher error');
  });

  logger.info({ vault: VAULT_PATH }, 'Vault watcher started');
}
