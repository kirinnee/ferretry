/**
 * Which project servers the launch's HARNESS approved for a ferret — asked of the harness plugin through its contract
 * (`approvedProjectServers`, an optional `uses`), never read from the harness's home by MCP (lead ruling: no
 * harness-home root for MCP). The harness plugin reads its own home.
 *
 * FAIL CLOSED: a harness that is off, still a skeleton, without the read, or that throws gives NO answer (`undefined`),
 * and the launch then binds no project server. A harness key with no reader here takes no project server at all, as
 * today (only Claude's runtimes were handed one).
 */
import type { FerretId } from '@ferretry/kernel/contract';
import type { McpProjectApprovals, McpProjectApprovalsRequest } from '../lib/inventory/project-sign-in.ts';

/** The read both harness contracts offer (`ClaudeCodeApi`, `CodexApi`), as MCP needs it. */
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
