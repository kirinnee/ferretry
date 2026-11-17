import type { FencedPath } from '@ferretry/kernel/contract';
import type { FerretRecord, Harness } from '../../../contract/index.ts';

/**
 * The conversation a ferret is bound to, and whether its harness still has it, for a move to judge BEFORE it writes or
 * stops anything (a launch that finds a conversation absent quietly starts a NEW one, which a move must never do unasked).
 *
 * `id` is the one the record names, else the one the harness PROVES its last launch wrote (Codex names its conversation after
 * launch: `Harness.provedConversation`), else none. `present` is the harness's own answer from the ferret's OWN home, where a
 * conversation lives whichever login the ferret runs on: `false` only when its absence is proved, `undefined` when the
 * harness cannot tell (or has no such question), and a launch resumes as asked on any doubt. Read-only: nothing is written.
 */
export interface BoundConversation {
  readonly id: string | undefined;
  readonly present: boolean | undefined;
}

export async function boundConversation(
  record: FerretRecord,
  harness: Harness | undefined,
): Promise<BoundConversation> {
  const id = record.harnessConversation ?? (await harness?.provedConversation?.(record.id).catch(() => undefined))?.id;
  if (id === undefined || harness?.hasConversation === undefined) return { id, present: undefined };
  const home = await harness.homeFor(record.id).catch(() => undefined);
  if (home === undefined) return { id, present: undefined };
  // The harness reads where the conversation lives from the home and the folder; nothing of a launch is needed to ask.
  const spec = {
    ferret: record.id,
    name: record.name,
    role: record.role,
    harness: record.harness,
    folder: record.folder as FencedPath,
    home,
    instructions: [],
    parts: [],
  };
  return { id, present: await harness.hasConversation(spec, id).catch(() => undefined) };
}
