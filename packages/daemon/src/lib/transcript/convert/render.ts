import type { ConversationEntry, ConversationShellEntry, ConversationToolEntry } from './conversation.ts';

/**
 * The pieces both writers render the same way, so a Claude target and a Codex target describe the
 * carried history in the same words.
 */

/** The entries a writer receives: user entries already carry their attachments as reference text. */
export type RenderableEntry =
  | Exclude<ConversationEntry, { kind: 'user' }>
  | {
      readonly kind: 'user';
      readonly text: string;
      readonly at?: string;
    };

/** A tool call that crosses as text, in the agent's turn: `[ran Read: /x] → output`. */
export function toolLine(entry: ConversationToolEntry | ConversationShellEntry): string {
  const name = entry.kind === 'shell' ? 'shell' : entry.name;
  const input = entry.kind === 'shell' ? entry.command : entry.input;
  const failed = entry.failed ? ' (failed)' : '';
  const output = entry.output;
  if (output === undefined) return `[ran ${name}: ${input}] (no result recorded)`;
  const shown = output.trim();
  return shown === ''
    ? `[ran ${name}: ${input}]${failed} → (no output)`
    : `[ran ${name}: ${input}]${failed} →\n${shown}`;
}

/**
 * A uuid derived from `base` for the `index`-th record of one file: the base's first 24 characters
 * and the index in the last twelve. Unique within the file, stable for the same input, and still a
 * well-formed uuid, which is all either harness asks of a record id.
 */
export function derivedUuid(base: string, index: number): string {
  return `${base.slice(0, 24)}${index.toString(16).padStart(12, '0')}`;
}

/** The leading `Exit code N` line Claude puts on a failed command's result, split off. */
export function exitCodeOf(output: string): { readonly code: number | undefined; readonly rest: string } {
  const match = /^Exit code (-?\d+)\n/u.exec(output);
  return match === null
    ? { code: undefined, rest: output }
    : { code: Number(match[1]), rest: output.slice(match[0].length) };
}
