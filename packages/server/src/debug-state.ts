/**
 * Debug state — tracks which agents have active debug subscribers
 * and the current run context for exchange capture.
 *
 * Shared between the credential proxy (capture) and the dashboard
 * channel (subscription management).
 */

import { logger } from './logger.js';

/** Agent IDs with at least one debug subscriber */
const activeAgents = new Set<string>();

/** Current run ID per agent (set on run start, cleared on completion) */
const currentRuns = new Map<string, string>();

/** Exchange counter per agent (resets when debug starts or run changes) */
const exchangeCounters = new Map<string, number>();

/**
 * Agents with debug subscribers that currently have a container running.
 * Used by the proxy to decide whether to capture, and to attribute
 * captured exchanges to the right agent.
 */
const runningDebugAgents = new Map<string, string>(); // agentId → runId

export function addDebugAgent(agentId: string): void {
  activeAgents.add(agentId);
  exchangeCounters.set(agentId, 0);
  logger.debug({ agentId }, 'Debug agent added');
}

export function removeDebugAgent(agentId: string): void {
  activeAgents.delete(agentId);
  exchangeCounters.delete(agentId);
}

export function isDebugActive(agentId: string): boolean {
  return activeAgents.has(agentId);
}

export function setCurrentRun(agentId: string, runId: string): void {
  currentRuns.set(agentId, runId);
  exchangeCounters.set(agentId, 0);
  // If debug is active for this agent, mark it as running
  if (activeAgents.has(agentId)) {
    runningDebugAgents.set(agentId, runId);
  }
}

export function clearCurrentRun(agentId: string): void {
  currentRuns.delete(agentId);
  runningDebugAgents.delete(agentId);
}

export function getCurrentRun(agentId: string): string | null {
  return currentRuns.get(agentId) ?? null;
}

export function nextExchangeIndex(agentId: string): number {
  const idx = exchangeCounters.get(agentId) ?? 0;
  exchangeCounters.set(agentId, idx + 1);
  return idx;
}

/** Returns true if any debug-active agent currently has a container running */
export function hasRunningDebugAgents(): boolean {
  return runningDebugAgents.size > 0;
}

/**
 * Returns the single running debug agent, or null if zero or multiple.
 * For the common case (one agent being debugged), this unambiguously
 * identifies which agent a proxy-captured exchange belongs to.
 */
export function getSingleRunningDebugAgent(): { agentId: string; runId: string } | null {
  if (runningDebugAgents.size !== 1) return null;
  const [agentId, runId] = runningDebugAgents.entries().next().value!;
  return { agentId, runId };
}

/** Returns all running debug agents (for multi-agent debug) */
export function getRunningDebugAgents(): Map<string, string> {
  return runningDebugAgents;
}
