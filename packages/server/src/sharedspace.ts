/**
 * SharedSpace — Tree-aware access control for the shared wiki layer.
 *
 * Read rules: ancestry chain (CEO → … → self) plus own subtree one level deep.
 * Write rules: own level and below. CEO has full access.
 */
import {
  getAgentById,
  getAncestryChain,
  getAgentTree,
  getAllSharedSpacePages,
  getCachedSharedSpaceIndex,
  getDescendants,
  getDirectChildren,
  getSharedSpacePage,
  invalidateSharedSpaceIndex,
  setCachedSharedSpaceIndex,
  upsertSharedSpacePage,
  type AgentRow,
  type SharedSpacePageRow,
} from './db.js';

// --- Access control ---

/**
 * Get the set of agent IDs whose pages this agent can read.
 * Read: ancestry chain + own subtree one level deep.
 */
export function getReadableOwners(agentId: string): Set<string> {
  const owners = new Set<string>();

  // Ancestry chain (CEO → ... → self)
  const ancestry = getAncestryChain(agentId);
  for (const a of ancestry) {
    owners.add(a.agent_id);
  }

  // Direct children (one level deep)
  const children = getDirectChildren(agentId);
  for (const c of children) {
    owners.add(c.agent_id);
  }

  // CEO pages (owner_agent_id = 'ceo') are readable by all
  owners.add('ceo');

  return owners;
}

/**
 * Get the set of agent IDs whose pages this agent can write.
 * Write: own level and below.
 */
export function getWritableOwners(agentId: string): Set<string> {
  const owners = new Set<string>();
  owners.add(agentId);

  // All descendants
  const descendants = getDescendants(agentId);
  for (const d of descendants) {
    owners.add(d.agent_id);
  }

  return owners;
}

/**
 * Check if an agent can read a page.
 * CEO (agentId = 'ceo') has full read access.
 */
export function canRead(agentId: string, page: SharedSpacePageRow): boolean {
  if (agentId === 'ceo') return true;
  const readable = getReadableOwners(agentId);
  return readable.has(page.owner_agent_id);
}

/**
 * Check if an agent can write a page.
 * CEO (agentId = 'ceo') has full write access.
 */
export function canWrite(agentId: string, page: SharedSpacePageRow): boolean {
  if (agentId === 'ceo') return true;
  const writable = getWritableOwners(agentId);
  return writable.has(page.owner_agent_id);
}

// --- SharedSpace index computation ---

/**
 * Compute the SharedSpace index for a given agent.
 * Lists title and summary of all readable pages.
 */
export function computeSharedSpaceIndex(agentId: string): string {
  const readableOwners = getReadableOwners(agentId);
  const allPages = getAllSharedSpacePages();

  const visiblePages = allPages.filter((p) => readableOwners.has(p.owner_agent_id));

  if (visiblePages.length === 0) return '';

  const lines = visiblePages.map(
    (p) => `- **${p.title}** (${p.page_id}): ${p.summary}`,
  );
  return lines.join('\n');
}

/**
 * Recompute and cache the SharedSpace index for an agent.
 */
export function recomputeAndCacheIndex(agentId: string): void {
  const index = computeSharedSpaceIndex(agentId);
  setCachedSharedSpaceIndex(agentId, index);
}

/**
 * Invalidate cached indices for all agents whose readable scope
 * includes a page owned by the given agent.
 */
export function invalidateIndicesForPageOwner(ownerAgentId: string): void {
  // Any agent that can read this owner's pages needs invalidation.
  // That means: the owner's ancestry chain, the owner itself,
  // and the owner's direct parent's other children (siblings don't read each other),
  // plus the CEO. In practice, invalidate all agents for simplicity.
  const allAgents = getAgentTree();
  const agentIds = allAgents.map((a) => a.agent_id);
  invalidateSharedSpaceIndex(agentIds);
}

/**
 * Ensure the cached index exists for an agent, computing if needed.
 */
export function ensureCachedIndex(agentId: string): string {
  const cached = getCachedSharedSpaceIndex(agentId);
  if (cached !== null) return cached;
  recomputeAndCacheIndex(agentId);
  return getCachedSharedSpaceIndex(agentId) || '';
}
