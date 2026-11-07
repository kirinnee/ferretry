/**
 * A command, coloured by what its parts DO, with a quiet copy beside it.
 *
 * Four monospace blocks in one flat tone are the reason the setup screen was
 * hard to read: they are the same length, the same weight and the same colour,
 * so finding the word that changed between two of them is a character-by-
 * character job. Colouring the binary, the verb, the flags and the literals
 * gives each command a silhouette — a reader recognises `fy daemon start`
 * against `fy daemon status` by shape long before they read either.
 *
 * The tones come from the `--syn-*` ramp every theme already ships for rendered
 * code fences, so a command here and a command in a transcript agree in all
 * fourteen themes, including the two high-contrast ones. Nothing is invented.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL. It speeds up a reader who can use it and
 * costs nothing to one who cannot: the text is unchanged, the copy control has
 * its own name, and no meaning is carried by hue alone.
 *
 * THE COMMAND IS THE LARGEST TEXT IN THE BLOCK, and larger than the prose around
 * it. It was `text-meta` — 11px — which is the size this interface uses for
 * badges and timestamps, and it is the wrong size for the one string a reader has
 * to check character by character before pressing Enter on their own machine. It
 * is now `text-title`, the same 15px the interface gives a session heading,
 * because within this block the command IS the heading. The copy control stayed
 * small in the same pass: the button was never the thing to read.
 */

import { type CommandToken, type CommandTokenKind, tokenizeCommand } from './command-syntax.ts';
import { type ClipboardWriter, CopyButton } from './copy-button.tsx';

/**
 * Kind → tone.
 *
 * Written out as whole class names on purpose: Tailwind scans source text, so a
 * composed `text-syn-${kind}` would resolve to nothing at build time.
 */
const TONE: Record<CommandTokenKind, string> = {
  binary: 'text-syn-keyword font-semibold',
  subcommand: 'text-syn-type',
  flag: 'text-syn-meta',
  string: 'text-syn-string',
  url: 'text-syn-string',
  operator: 'text-faint',
  comment: 'text-syn-comment italic',
  plain: 'text-code-fg',
};

export interface CommandBlockProps {
  /** Exactly what the reader must run — never a paraphrase. */
  readonly command: string;
  /** Names the block for the copy control, e.g. `Copy install commands`. */
  readonly copyLabel: string;
  readonly write: ClipboardWriter;
}

/**
 * A copyable command block.
 *
 * `overflow-x-auto` is paired with `overflow-y-hidden` deliberately: on its own
 * it grows a phantom vertical scrollbar inside the box, which the original UI
 * hit and fixed the same way.
 *
 * The copy control sits beside the code rather than under it — a row saved on
 * every block, and the affordance lands where the eye already is.
 */
export function CommandBlock({ command, copyLabel, write }: CommandBlockProps) {
  return (
    <div className="flex min-w-0 items-start gap-1 rounded-control border border-code-border bg-code-bg py-2 pl-2 pr-1">
      <pre className="m-0 min-w-0 flex-1 self-center overflow-x-auto overflow-y-hidden font-mono text-title leading-base text-code-fg">
        <code>
          {tokenizeCommand(command).map((token: CommandToken) => (
            <span key={token.start} className={TONE[token.kind]}>
              {token.text}
            </span>
          ))}
        </code>
      </pre>
      <CopyButton text={command} label={copyLabel} write={write} />
    </div>
  );
}
