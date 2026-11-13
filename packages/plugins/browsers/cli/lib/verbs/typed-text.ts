import { SecretNameSchema } from '@ferretry/core-vault/contract';
import { flag, type Parsed, UsageError } from '../args.ts';
import type { Plan, PlanContext } from '../plan.ts';

/**
 * Where typed text comes from, for the two verbs that type (`browser type`, `browser page type`).
 *
 * THE COMMAND LINE IS NOT PRIVATE. A word in argv is readable by every user of the machine in `ps` and
 * `/proc/<pid>/cmdline`, and lands in shell history. Text typed as words stays (v4 parity, and an ordinary label or
 * search is fine there), but anything sensitive goes in through `--stdin` (read from standard input, never in argv) or
 * `--secret NAME` (a stored secret, by name). A value that came from either is never printed back, whatever the
 * daemon says: see `Plan.scrub`.
 */

/** The two options both typing verbs add. */
export const TEXT_SOURCE_FLAGS = {
  stdin: flag.on('stdin'),
  secret: flag.text('secret'),
} as const;

/** What `--secret` says today: the Vault runs commands with a secret but has no way to hand one to a page act. */
export const SECRET_TYPING_GAP =
  '--secret is not available in this build: the Vault can run a command with a stored secret but cannot hand one to a page act, and Ferretry never reads a secret back (a declared gap). Use --stdin, or ask the owner to type it into the page with browser_request_input';

export type TypedText = { readonly text: string } | { readonly refusal: Plan };

/**
 * The text to type: the words from `from` on, or standard input with `--stdin` (one trailing newline dropped, as
 * `echo` adds one), or a stored secret with `--secret NAME`. Exactly one source.
 */
export async function typedText(words: Parsed, from: number, context: PlanContext): Promise<TypedText> {
  const given = words.words(from);
  const secret = words.text('secret');
  const stdin = words.on('stdin');
  if (stdin && secret !== undefined) throw new UsageError('give the text one way: --stdin or --secret, not both');
  if ((stdin || secret !== undefined) && given !== undefined)
    throw new UsageError(
      `${stdin ? '--stdin' : '--secret'} takes the text from ${stdin ? 'standard input' : 'the secret'}: leave it off the command line`,
    );
  if (secret !== undefined) {
    if (!SecretNameSchema.safeParse(secret).success)
      throw new UsageError(
        '--secret takes the NAME of a stored secret (capital letters, digits and _), never its value',
      );
    return { refusal: { kind: 'refuse', message: SECRET_TYPING_GAP } };
  }
  if (stdin) return { text: (await context.readStdin()).replace(/\r?\n$/u, '') };
  return { text: given ?? '' };
}

/** The shortest typed text that is scrubbed from what a verb prints: shorter would blank out ordinary words. */
export const SCRUB_MIN_LENGTH = 3;

/** The text to scrub from output, if it is long enough to be told apart. */
export const scrubbing = (text: string): readonly string[] => (text.length >= SCRUB_MIN_LENGTH ? [text] : []);
