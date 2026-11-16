/**
 * The few words and rules every links surface shares: how a harness is named, and how a conversation's folder reads.
 * `conversationFolder` is today's (`@ferretry/protocol` `conversation-import.ts`), which only the browser used.
 */

import type { HarnessKey } from '@ferretry/core-ferrets/contract';

export type { HarnessKey };

/** A harness as a setup sentence names it. */
export const HARNESS_NAMES: Readonly<Record<HarnessKey, string>> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** A harness as a badge names it. */
export const HARNESS_SHORT: Readonly<Record<HarnessKey, string>> = { 'claude-code': 'Claude', codex: 'Codex' };

/** The wire's harness id as one this app draws, or `undefined` for a harness it has no words for. */
export const harnessKeyOf = (harness: string): HarnessKey | undefined =>
  harness === 'claude-code' || harness === 'codex' ? harness : undefined;

/** Where a throwaway run works: the system's temp folders, and a harness's scratch folder anywhere. */
const TEMP_ROOTS = ['/tmp/', '/private/tmp/', '/var/tmp/', '/var/folders/', '/private/var/folders/'] as const;
const SCRATCH_SEGMENTS = new Set(['scratch', 'scratchpad']);
/** A segment that is an id rather than a name: a UUID, or a long run of hex. */
const HASH_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,})$/iu;

/** A conversation's folder as a row says it: a short name, and whether it is a throwaway scratch folder. */
export interface ConversationFolder {
  /** The folder's own name, or `undefined` for a scratch folder whose name is only an id or "scratchpad". */
  readonly name: string | undefined;
  readonly scratch: boolean;
}

/**
 * The folder a row names: its last segment, never a hash path. A folder under the system's temp folders,
 * or inside a `scratch`/`scratchpad` folder, is marked scratch, and keeps a name only when its last
 * segment is one a person chose (`/tmp/wt-cart` → `wt-cart`; `…/<uuid>/scratchpad` → none).
 */
export const conversationFolder = (project: string): ConversationFolder => {
  const segments = project.split(/[\\/]+/u).filter(segment => segment !== '');
  const last = segments.at(-1);
  const scratch =
    TEMP_ROOTS.some(root => `${project.replace(/\\/gu, '/')}/`.startsWith(root)) ||
    segments.some(segment => SCRATCH_SEGMENTS.has(segment.toLowerCase()));
  if (last === undefined) return { name: project === '' ? undefined : project, scratch };
  const named = !scratch || !(SCRATCH_SEGMENTS.has(last.toLowerCase()) || HASH_SEGMENT.test(last));
  return { name: named ? last : undefined, scratch };
};
