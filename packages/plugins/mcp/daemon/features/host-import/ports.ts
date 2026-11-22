/** What the setup import's write needs of the kernel's config service, as two narrow calls (so a test fakes only these). */
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';

export interface McpConfigWrite {
  /** Whether `config/mcp/<name>.yaml` exists in any state (in effect, held for the owner, or broken). */
  taken(name: string): boolean;
  /** Writes the whole document as a NEW file only: never over one that is there (the caller's own act, judged as such). */
  create(name: string, documentText: string): Promise<ConfigWriteOutcome>;
  /** The config etag of `config/mcp/<name>.yaml` on disk right now, or `'absent'`. */
  etag(name: string): Promise<string>;
  /** Replaces the whole document for an update the person accepted, pinned to `ifMatch` (the etag read just before). */
  replace(name: string, documentText: string, ifMatch: string): Promise<ConfigWriteOutcome>;
}
