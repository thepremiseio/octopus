/**
 * SharedSpace — Obsidian-compatible markdown vault with explicit access control.
 *
 * Pages are `.md` files with YAML frontmatter stored on the filesystem.
 * SQLite holds a frontmatter-only index for fast querying.
 * Access is controlled by the `access` field in each page's frontmatter.
 */
import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

import { VAULT_PATH } from './config.js';
import {
  getAgentById,
  getAncestryChain,
  getTopLevelBranch,
  getAgentTree,
  resolveAgent,
  upsertSharedspaceIndex,
  deleteSharedspaceIndex,
  listSharedspaceIndex,
  invalidateSharedSpaceIndex,
  getCachedSharedSpaceIndex,
  setCachedSharedSpaceIndex,
} from './db.js';
import { broadcast } from './container-runner.js';

// --- Types ---

export type AccessLevel =
  | 'ceo-only'
  | 'owner-and-above'
  | 'branch'
  | 'everyone'
  | string[]; // explicit agent list

export interface VaultPage {
  page_id: string;
  owner: string;
  access: AccessLevel;
  summary: string;
  updated: string; // ISO 8601
  body: string;
  file_path: string; // absolute path on disk
}

// Index-only variant (no body)
export type VaultPageMeta = Omit<VaultPage, 'body'>;

/**
 * Derive a display name from a page_id (last path segment).
 * e.g. "policies/hitl" → "hitl", "overview" → "overview"
 */
export function pageDisplayName(pageId: string): string {
  const lastSlash = pageId.lastIndexOf('/');
  return lastSlash >= 0 ? pageId.slice(lastSlash + 1) : pageId;
}

// --- Error types ---

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

export class ParentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParentNotFoundError';
  }
}

export class PageHasChildrenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageHasChildrenError';
  }
}

// --- Frontmatter parsing ---

/**
 * Parse a markdown file's YAML frontmatter and body.
 */
export function parseFrontmatter(raw: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const result = matter(raw);
  return { meta: result.data, body: result.content };
}

// --- Path utilities ---

/**
 * Derive page_id from an absolute file path relative to the vault root.
 * e.g. /path/to/vault/work/startup-a/overview.md → work/startup-a/overview
 */
export function pageIdFromPath(vaultRoot: string, filePath: string): string {
  const rel = path.relative(vaultRoot, filePath);
  // Strip .md extension and normalize separators to forward slashes
  return rel.replace(/\.md$/, '').split(path.sep).join('/');
}

/**
 * Inverse of pageIdFromPath — returns absolute path.
 */
export function pathFromPageId(vaultRoot: string, pageId: string): string {
  return path.join(vaultRoot, ...pageId.split('/')) + '.md';
}

// --- Access control ---

/**
 * Resolve a page owner (which may be a name or an agent_id) to an agent_id.
 * Returns the original string if resolution fails.
 */
function resolveOwnerId(owner: string): string {
  const agent = resolveAgent(owner);
  return agent ? agent.agent_id : owner;
}

/**
 * Parse the access field from frontmatter into a typed AccessLevel.
 */
function parseAccess(raw: unknown): AccessLevel {
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (
      s === 'ceo-only' ||
      s === 'owner-and-above' ||
      s === 'branch' ||
      s === 'everyone'
    ) {
      return s;
    }
    // Could be a JSON-encoded array or bracket-notation list like [Laura, Arthur]
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // Not valid JSON — try bracket-notation comma-separated list
      const match = s.match(/^\[(.+)\]$/);
      if (match) {
        return match[1]!
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
      }
    }
  }
  // Default fallback
  return 'ceo-only';
}

/**
 * Check if an agent can read a page.
 */
export function canRead(
  agentId: string | 'ceo',
  page: { owner: string; access: AccessLevel },
): boolean {
  if (agentId === 'ceo') return true;

  const ownerId = resolveOwnerId(page.owner);

  // Owner can always read their own pages
  if (ownerId === agentId) return true;

  const access = page.access;

  if (access === 'ceo-only') return false;

  if (access === 'everyone') return true;

  if (access === 'owner-and-above') {
    // Walk the parent chain from the owner up to CEO
    const ownerAgent = getAgentById(ownerId);
    if (!ownerAgent) return false;

    const chain = getAncestryChain(ownerId);
    return chain.some((a) => a.agent_id === agentId);
  }

  if (access === 'branch') {
    // All agents in the same top-level branch as the owner
    const ownerBranch = getTopLevelBranch(ownerId);
    const readerBranch = getTopLevelBranch(agentId);
    if (!ownerBranch || !readerBranch) return false;
    return ownerBranch.agent_id === readerBranch.agent_id;
  }

  // Explicit agent list (names or IDs) — owner and CEO are always implicit
  if (Array.isArray(access)) {
    return access.some((entry) => {
      const resolved = resolveAgent(entry);
      return resolved?.agent_id === agentId;
    });
  }

  return false;
}

/**
 * Check if an agent can write a page.
 * Only the owner and CEO can write.
 */
export function canWrite(
  agentId: string | 'ceo',
  page: { owner: string },
): boolean {
  if (agentId === 'ceo') return true;
  return resolveOwnerId(page.owner) === agentId;
}

// --- Vault file operations ---

/**
 * Read and parse a single vault page from disk.
 */
export function readPageFromDisk(filePath: string): VaultPage | null {
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const { meta, body } = parseFrontmatter(raw);
  const pageId = pageIdFromPath(VAULT_PATH, filePath);

  return {
    page_id: pageId,
    owner: String(meta.owner || 'ceo'),
    access: parseAccess(meta.access),
    summary: String(meta.summary || ''),
    updated: String(meta.updated || new Date().toISOString()),
    body,
    file_path: filePath,
  };
}

/**
 * Serialize a VaultPage to frontmatter + body markdown.
 */
function serializePage(page: VaultPage): string {
  const frontmatter: Record<string, unknown> = {
    owner: page.owner,
    access: page.access,
    summary: page.summary,
    updated: page.updated,
  };
  return matter.stringify(page.body, frontmatter);
}

// --- Service operations ---

/**
 * Read a page with access control.
 */
export function readPage(
  pageId: string,
  requesterId: string | 'ceo',
): VaultPage {
  const filePath = pathFromPageId(VAULT_PATH, pageId);
  const page = readPageFromDisk(filePath);
  if (!page) {
    throw new AccessDeniedError(`Page '${pageId}' not found`);
  }

  if (!canRead(requesterId, page)) {
    throw new AccessDeniedError(`Access denied: cannot read page '${pageId}'`);
  }

  return page;
}

/**
 * Create or update a page with access control.
 */
export function writePage(
  pageId: string,
  content: {
    summary?: string;
    body?: string;
    access?: AccessLevel;
    owner?: string;
  },
  requesterId: string | 'ceo',
): VaultPage {
  const filePath = pathFromPageId(VAULT_PATH, pageId);
  const existing = readPageFromDisk(filePath);
  const isCreate = !existing;

  if (isCreate) {
    // Owner is required on create
    if (!content.owner) {
      throw new ParentNotFoundError('owner is required when creating a page');
    }
  } else {
    // Check write access on update
    if (!canWrite(requesterId, existing)) {
      throw new AccessDeniedError(
        `Access denied: cannot write page '${pageId}'`,
      );
    }
  }

  const now = new Date().toISOString();
  const page: VaultPage = {
    page_id: pageId,
    owner: isCreate ? content.owner! : existing!.owner,
    access: content.access ?? existing?.access ?? 'ceo-only',
    summary: content.summary ?? existing?.summary ?? '',
    updated: now,
    body: content.body ?? existing?.body ?? '',
    file_path: filePath,
  };

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // Write to disk
  fs.writeFileSync(filePath, serializePage(page), 'utf-8');

  // Update index
  upsertSharedspaceIndex({
    page_id: page.page_id,
    owner: page.owner,
    access: page.access,
    summary: page.summary,
    updated: page.updated,
    file_path: page.file_path,
  });

  // Invalidate agent context index cache
  invalidateAllAgentIndices();

  // Emit WS event
  broadcast('sharedspace.page.updated', {
    page_id: pageId,
    summary: page.summary,
    owner_agent_id: page.owner,
    updated_by_agent_id: requesterId,
    operation: isCreate ? 'created' : 'updated',
    access: page.access,
  });

  return page;
}

/**
 * Delete a page with access control.
 */
export function deletePage(pageId: string, requesterId: string | 'ceo'): void {
  const filePath = pathFromPageId(VAULT_PATH, pageId);
  const page = readPageFromDisk(filePath);
  if (!page) return; // Already gone

  if (!canWrite(requesterId, page)) {
    throw new AccessDeniedError(
      `Access denied: cannot delete page '${pageId}'`,
    );
  }

  // Check for child .md files in the corresponding subdirectory
  const pageDir = filePath.replace(/\.md$/, '');
  if (fs.existsSync(pageDir) && fs.statSync(pageDir).isDirectory()) {
    const children = fs
      .readdirSync(pageDir, { recursive: true })
      .filter((f) => String(f).endsWith('.md'));
    if (children.length > 0) {
      throw new PageHasChildrenError(
        `Cannot delete '${pageId}': has ${children.length} child page(s). Delete children first.`,
      );
    }
  }

  // Delete from disk
  fs.unlinkSync(filePath);

  // Delete from index
  deleteSharedspaceIndex(pageId);

  // Invalidate agent context index cache
  invalidateAllAgentIndices();

  // Emit WS event
  broadcast('sharedspace.page.updated', {
    page_id: pageId,
    summary: page.summary,
    owner_agent_id: page.owner,
    updated_by_agent_id: requesterId,
    operation: 'deleted',
    access: page.access,
  });
}

/**
 * List pages with access control. Returns metadata only (no body).
 */
export function listPages(
  prefix: string | undefined,
  requesterId: string | 'ceo',
): VaultPageMeta[] {
  const allMeta = listSharedspaceIndex(prefix);

  return allMeta
    .filter((meta) => {
      const accessLevel = parseAccess(meta.access);
      return canRead(requesterId, { owner: meta.owner, access: accessLevel });
    })
    .map((meta) => ({
      page_id: meta.page_id,
      owner: meta.owner,
      access: parseAccess(meta.access),
      summary: meta.summary,
      updated: meta.updated,
      file_path: meta.file_path,
    }));
}

// --- Agent context index ---

/**
 * Invalidate cached context indices for all agents.
 * Called after any vault write/delete to ensure agents get fresh indices.
 */
export function invalidateAllAgentIndices(): void {
  const allAgents = getAgentTree();
  const agentIds = allAgents.map((a) => a.agent_id);
  invalidateSharedSpaceIndex(agentIds);
}

/**
 * Build the formatted SharedSpace context index for an agent's system prompt.
 * Lists all pages the agent can read, one per line, with title and summary.
 * Reads from the SQLite index table, not the filesystem.
 */
export function buildAgentContextIndex(agentId: string): string {
  const allMeta = listSharedspaceIndex();

  const visible = allMeta.filter((meta) => {
    const accessLevel = parseAccess(meta.access);
    return canRead(agentId, { owner: meta.owner, access: accessLevel });
  });

  if (visible.length === 0) return '';

  const lines = visible.map(
    (p) => `- **${pageDisplayName(p.page_id)}** (${p.page_id}): ${p.summary}`,
  );
  return lines.join('\n');
}

/**
 * Ensure the cached context index exists for an agent, computing if needed.
 */
export function ensureCachedIndex(agentId: string): string {
  const cached = getCachedSharedSpaceIndex(agentId);
  if (cached !== null) return cached;
  const index = buildAgentContextIndex(agentId);
  setCachedSharedSpaceIndex(agentId, index);
  return index;
}
