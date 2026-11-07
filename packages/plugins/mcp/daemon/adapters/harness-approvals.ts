/**
 * Which project servers the launch's HARNESS approved for a ferret — asked of the harness plugin through its contract
 * (`approvedProjectServers`, an optional `uses`), never read from the harness's home by MCP (lead ruling: no
 * harness-home root for MCP). The harness plugin reads its own home.
 *
 * FAIL CLOSED: a harness that is off, without the read, or that throws gives NO answer (`undefined`),
 * and the launch then binds no project server. A harness key with no reader here takes no project server at all, as
 * today (only Claude's runtimes were handed one): it answers `not-taken`, so nothing is renewed for it either. Codex
 * is deliberately given no reader. Its answer never depends on its daemon half: a Codex port that answered nothing
 * (turned off, say) would give `undefined`, which renews the project's sign-in for a launch that is never handed it.
 */
import type { FerretId } from '@ferretry/kernel/contract';
import type { McpProjectApprovals, McpProjectApprovalsRequest } from '../lib/inventory/project-sign-in.ts';

/** The read a harness contract offers (`ClaudeCodeApi.approvedProjectServers`), as MCP needs it. */
export interface HarnessApprovalsReader {
  approvedProjectServers?(query: {
    readonly ferret: FerretId;
    readonly root: string;
    readonly servers: readonly string[];
  }): Promise<McpProjectApprovals>;
}

/** By harness key: the harness plugin's port as it is right now (`uses.<port>.current()`), or `undefined` when off. */
export type HarnessApprovalsReaders = Readonly<Record<string, () => HarnessApprovalsReader | undefined>>;

export const harnessProjectApprovals =
  (readers: HarnessApprovalsReaders, harness: string, ferret: FerretId) =>
  async (request: McpProjectApprovalsRequest): Promise<McpProjectApprovals | undefined> => {
    const reader = Object.hasOwn(readers, harness) ? readers[harness] : undefined;
    if (reader === undefined)
      return { state: 'not-taken', reason: `A ${harness} ferret is handed no project server’s sign-in.` };
    const port = reader();
    if (port?.approvedProjectServers === undefined) return undefined;
    try {
      return await port.approvedProjectServers({ ferret, root: request.root, servers: request.servers });
    } catch {
      return undefined;
    }
  };
