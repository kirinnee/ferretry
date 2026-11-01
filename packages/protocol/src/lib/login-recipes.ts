import { z } from 'zod';
import { InstantSchema } from './common.ts';

/**
 * LOGIN RECIPES: how a saved login signs in, step by step, and what the daemon has SEEN about it
 * (docs/input-requests.md, "Login recipes"). Both ride with the saved login and neither is secret.
 *
 * - A **recipe** is the owner's Markdown: "Open app.vercel.com → Continue with Google → [[GOOGLE_KIRIN]] → wait
 *   for the phone approval → done when the dashboard shows". `[[ID]]` names another saved login, whose recipe the
 *   ferret is handed too. A recipe never holds a value: a change whose text contains a saved or vault value is
 *   refused, and the schema keeps out control and hidden characters, so nothing can ride in it unseen.
 * - **Observed facts** are written ONLY by the daemon, from what it saw while typing a saved login into a real
 *   target: the field was a password field (or the terminal had echo off), nothing echoed the value after submit,
 *   the page moved on, which second factor followed. Never from an agent's words, and never from page text.
 * - A **proposal** is a ferret's suggested recipe after a sign-in. It is the ferret's words, shown as such, and it
 *   changes nothing until the owner approves it, unless the owner turned auto-apply on for that one login.
 *
 * This file depends on nothing in `login-entries.ts`, which builds the entry and the hint from it.
 */

export const LOGIN_RECIPE_MAX_LENGTH = 4_000;
/** Most proposals one login holds at once: a fourth replaces the oldest. */
export const LOGIN_RECIPE_PROPOSALS_MAX = 3;
/** Most places one login keeps facts for (its login domains and terminal keys). */
export const LOGIN_OBSERVED_MAX = 16;
export const LOGIN_PROPOSAL_WHY_MAX_LENGTH = 280;

/**
 * Characters that draw nothing, or nothing a person can tell apart, while a model still reads them: control and
 * format characters (zero-width, bidi), every default-ignorable code point (variation selectors, which can smuggle
 * bytes inside one glyph, Hangul fillers), private-use and unassigned code points, line and paragraph separators,
 * and the blank braille pattern. A recipe or a reason holding one is refused, so what the owner reads is all there is.
 */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/u;

/** Whether a text holds a character that hides from the reader (see {@link UNSEEN}); lines and tabs are allowed. */
export const hidesCharacters = (text: string): boolean => UNSEEN.test(text.replaceAll(/[\n\t]/gu, ''));

/** The markers a hint fences a recipe with: a recipe may not contain them, so it cannot close its own fence. */
export const RECIPE_FENCE_OPEN = '<<<recipe';
export const RECIPE_FENCE_CLOSE = 'recipe>>>';

/**
 * A recipe's text: lines and tabs, CRLF read as LF, no character that hides from the owner ({@link UNSEEN}), and
 * not the hint's fence markers.
 */
export const LoginRecipeSchema = z
  .string()
  .transform(text => text.replaceAll('\r\n', '\n').trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(LOGIN_RECIPE_MAX_LENGTH)
      .refine(text => !hidesCharacters(text), 'a recipe is plain lines and tabs, with no control or hidden characters')
      .refine(
        text => !text.includes(RECIPE_FENCE_OPEN) && !text.includes(RECIPE_FENCE_CLOSE),
        `a recipe cannot contain ${RECIPE_FENCE_OPEN} or ${RECIPE_FENCE_CLOSE}`,
      ),
  );
export type LoginRecipe = z.output<typeof LoginRecipeSchema>;

/** `[[GOOGLE_KIRIN]]` in a recipe: another saved login's handle. */
const REFERENCE = /\[\[([A-Z][A-Z0-9_]{0,63})\]\]/gu;

/** The saved logins a recipe names with `[[ID]]`, each once, in the order they appear. */
export function recipeReferences(recipe: string | undefined): readonly string[] {
  if (recipe === undefined) return [];
  return [...new Set([...recipe.matchAll(REFERENCE)].map(match => match[1] as string))];
}

/** The recipe with every `[[from]]` naming `to` instead (a rename), or left as written when `to` is absent. */
export function recipeRenamed(recipe: string, from: string, to: string): string {
  return recipe.replaceAll(`[[${from}]]`, `[[${to}]]`);
}

/** One yes-or-no fact, as often as the daemon has seen it the same way in a row, and when it last did. */
export const LoginObservedFlagSchema = z.strictObject({
  value: z.boolean(),
  observedAt: InstantSchema,
  count: z.number().int().min(1).max(1_000_000),
});
export type LoginObservedFlag = z.infer<typeof LoginObservedFlagSchema>;

/**
 * The second factor the daemon saw follow the password: `code` (a one-time code card on the same login, soon
 * after), `push` (the page waited on the sign-in host, then moved on with no code typed: an approval somewhere
 * else), `none` (the page moved on at once).
 */
export const LOGIN_SECOND_FACTORS = ['push', 'code', 'none'] as const;
export const LoginSecondFactorSchema = z.enum(LOGIN_SECOND_FACTORS);
export type LoginSecondFactor = z.infer<typeof LoginSecondFactorSchema>;

export const LoginObservedSecondFactorSchema = z.strictObject({
  value: LoginSecondFactorSchema,
  observedAt: InstantSchema,
  count: z.number().int().min(1).max(1_000_000),
});

/**
 * WHAT THE DAEMON SAW, for one login at one place: a web host (`accounts.google.com`) or a terminal's key
 * (`sudo@kirin-box`). `identity` is a digest of the field as the daemon found it (origin, frame, tag, type, name,
 * id, autocomplete; or the program for a terminal): when a later delivery finds a different identity there, the
 * old facts are dropped and counting starts again, because they were about another field.
 *
 * `masked`: every secret field was a password input, or the terminal had echo off and a recognised program read
 * it. `noEchoAfterSubmit`: after the submit the daemon looked at the page text or the screen itself and the value
 * was not in it. `navigatedAway`: the page showed a new document within a few seconds of the submit.
 */
export const LoginObservedSchema = z.strictObject({
  at: z
    .string()
    .max(320)
    .regex(/^(?:[a-z0-9][a-z0-9._+-]{0,63}@)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/u),
  surface: z.enum(['page', 'terminal']),
  identity: z.string().regex(/^[0-9a-f]{16}$/u),
  /** When this identity was first seen here. */
  since: InstantSchema,
  masked: LoginObservedFlagSchema.optional(),
  noEchoAfterSubmit: LoginObservedFlagSchema.optional(),
  navigatedAway: LoginObservedFlagSchema.optional(),
  secondFactor: LoginObservedSecondFactorSchema.optional(),
  /**
   * Whether the fill was the OWNER's own tap from a paired device that went through: on a page, a device tap that
   * moved on unsteered (`false`: one that did not, which starts the count again); on a terminal, a device tap typed
   * hidden into a proved sudo, su or doas. Plan fills, rule fills and the admin token's deliveries never write it, so
   * only this fact counts toward a standing rule's history (sign-in-rules.ts).
   */
  tapped: LoginObservedFlagSchema.optional(),
});
export type LoginObserved = z.infer<typeof LoginObservedSchema>;

/**
 * An observed fact as a FERRET may read it (`account_hint`, the login hint): everything but `tapped`, which exists only
 * to say whether the owner's own taps qualify a sign-in for a standing rule. A ferret learns nothing about rules, so the
 * hint never changes because of one (secrev-1271 L2). Strict, so a projection that forgot to drop it fails to parse.
 */
export const LoginObservedHintSchema = LoginObservedSchema.omit({ tapped: true });
export type LoginObservedHint = z.infer<typeof LoginObservedHintSchema>;

/** The facts a ferret may read: each without its `tapped` count. */
export const ferretObserved = (facts: readonly LoginObserved[]): LoginObservedHint[] =>
  facts.map(({ tapped: _ownerOnly, ...fact }) => fact);

/** One delivery's worth of facts, as the input service reports them; folded into {@link LoginObserved}. */
export interface LoginObservation {
  readonly at: string;
  readonly surface: 'page' | 'terminal';
  readonly identity: string;
  readonly masked?: boolean;
  readonly noEchoAfterSubmit?: boolean;
  readonly navigatedAway?: boolean;
  readonly secondFactor?: LoginSecondFactor;
  /** The owner's own device tap went through (written for `by: 'device'` only). */
  readonly tapped?: boolean;
}

function folded<T extends boolean | LoginSecondFactor>(
  previous: { readonly value: T; readonly observedAt: string; readonly count: number } | undefined,
  value: T | undefined,
  observedAt: string,
): { value: T; observedAt: string; count: number } | undefined {
  if (value === undefined) return previous === undefined ? undefined : { ...previous };
  const count = previous !== undefined && previous.value === value ? Math.min(previous.count + 1, 1_000_000) : 1;
  return { value, observedAt, count };
}

/**
 * Folds one observation into what a login keeps: the same place and identity counts up (a fact seen the other way
 * starts again at 1), a new identity at the same place replaces the facts there, and the newest places are kept.
 */
export function foldObservation(
  kept: readonly LoginObserved[],
  seen: LoginObservation,
  observedAt: string,
): readonly LoginObserved[] {
  const previous = kept.find(entry => entry.at === seen.at);
  const same = previous !== undefined && previous.identity === seen.identity && previous.surface === seen.surface;
  const base = same ? previous : undefined;
  const next: LoginObserved = {
    at: seen.at,
    surface: seen.surface,
    identity: seen.identity,
    since: base?.since ?? observedAt,
  };
  const masked = folded(base?.masked, seen.masked, observedAt);
  const echo = folded(base?.noEchoAfterSubmit, seen.noEchoAfterSubmit, observedAt);
  const navigated = folded(base?.navigatedAway, seen.navigatedAway, observedAt);
  const factor = folded(base?.secondFactor, seen.secondFactor, observedAt);
  const tapped = folded(base?.tapped, seen.tapped, observedAt);
  const entry: LoginObserved = {
    ...next,
    ...(masked === undefined ? {} : { masked }),
    ...(echo === undefined ? {} : { noEchoAfterSubmit: echo }),
    ...(navigated === undefined ? {} : { navigatedAway: navigated }),
    ...(factor === undefined ? {} : { secondFactor: factor }),
    ...(tapped === undefined ? {} : { tapped }),
  };
  return [...kept.filter(other => other.at !== seen.at), entry].slice(-LOGIN_OBSERVED_MAX);
}

/** A proposal's handle. */
export const LoginRecipeProposalIdSchema = z.string().regex(/^rp_[0-9a-f]{16}$/u);
export type LoginRecipeProposalId = z.infer<typeof LoginRecipeProposalIdSchema>;

const oneLine = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine(
      text => !/[\n\t]/u.test(text) && !hidesCharacters(text),
      'must be one line with no control or hidden characters',
    );

/**
 * A FERRET'S SUGGESTED RECIPE, waiting for the owner. `recipe` is the whole new text; `base` is the recipe it was
 * proposed against (absent: there was none), so the owner sees exactly what would change. `why` is the ferret's own
 * words and is shown as such.
 */
/** Who wrote the recipe as it stands: absent is the owner (typed or approved); `ferret` is an auto-applied proposal. */
export const LoginRecipeAuthorSchema = z.literal('ferret');

export const LoginRecipeProposalSchema = z.strictObject({
  id: LoginRecipeProposalIdSchema,
  recipe: LoginRecipeSchema,
  base: LoginRecipeSchema.optional(),
  why: oneLine(LOGIN_PROPOSAL_WHY_MAX_LENGTH),
  sessionId: z.string().min(1).max(128),
  agendaItemId: z.string().min(1).max(32).optional(),
  proposedAt: InstantSchema,
});
export type LoginRecipeProposal = z.infer<typeof LoginRecipeProposalSchema>;

/** What a ferret sends to propose a recipe (`account_propose`, `POST /v1/secrets/logins/:id/recipe/proposals`). */
export const LoginRecipeProposeRequestSchema = z.strictObject({
  recipe: LoginRecipeSchema,
  why: oneLine(LOGIN_PROPOSAL_WHY_MAX_LENGTH),
});
export type LoginRecipeProposeRequest = z.input<typeof LoginRecipeProposeRequestSchema>;

/** What a proposal came to: waiting for the owner, or applied at once because the owner allowed that. */
export const LoginRecipeProposedSchema = z.strictObject({
  id: LoginRecipeProposalIdSchema,
  login: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u),
  state: z.enum(['pending', 'applied']),
  agendaItemId: z.string().min(1).max(32).optional(),
});
export type LoginRecipeProposed = z.infer<typeof LoginRecipeProposedSchema>;

/** The owner's answer to a proposal (`POST /v1/secrets/logins/:id/recipe/proposals/:pid`). */
export const LoginRecipeDecisionSchema = z.strictObject({ decision: z.enum(['approve', 'decline']) });
export type LoginRecipeDecision = z.infer<typeof LoginRecipeDecisionSchema>;

/** One line of a recipe diff: kept, removed or added. */
export interface RecipeDiffLine {
  readonly op: ' ' | '-' | '+';
  readonly text: string;
}

/**
 * The lines that change from `base` to `next`, by longest common subsequence: what a proposal card and the app
 * show. A recipe is at most a few hundred lines, so the quadratic table is small.
 */
export function recipeDiff(base: string | undefined, next: string): readonly RecipeDiffLine[] {
  const before = base === undefined || base === '' ? [] : base.split('\n');
  const after = next.split('\n');
  const rows = before.length;
  const columns = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let row = rows - 1; row >= 0; row -= 1)
    for (let column = columns - 1; column >= 0; column -= 1)
      (table[row] as number[])[column] =
        before[row] === after[column]
          ? ((table[row + 1] as number[])[column + 1] as number) + 1
          : Math.max((table[row + 1] as number[])[column] as number, (table[row] as number[])[column + 1] as number);
  const lines: RecipeDiffLine[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      lines.push({ op: ' ', text: before[row] as string });
      row += 1;
      column += 1;
    } else if (((table[row + 1] as number[])[column] as number) >= ((table[row] as number[])[column + 1] as number)) {
      lines.push({ op: '-', text: before[row] as string });
      row += 1;
    } else {
      lines.push({ op: '+', text: after[column] as string });
      column += 1;
    }
  }
  for (; row < rows; row += 1) lines.push({ op: '-', text: before[row] as string });
  for (; column < columns; column += 1) lines.push({ op: '+', text: after[column] as string });
  return lines;
}

/** The diff as text, `- ` and `+ ` before changed lines: an agenda card's context. */
export function recipeDiffText(base: string | undefined, next: string): string {
  return recipeDiff(base, next)
    .map(line => `${line.op} ${line.text}`.trimEnd())
    .join('\n');
}

const FACTOR_WORDS: Readonly<Record<LoginSecondFactor, string>> = {
  push: '2FA by approval',
  code: '2FA by code',
  none: 'no 2FA step',
};

/** What the daemon saw at one place, in a few words: `accounts.google.com: password field, no echo, moved on, 2FA by approval (seen 3×, 2026-10-30)`. */
export function observedWords(seen: LoginObserved): string {
  const parts: string[] = [];
  if (seen.masked !== undefined)
    parts.push(
      seen.masked.value
        ? seen.surface === 'page'
          ? 'password field'
          : 'typing hidden'
        : seen.surface === 'page'
          ? 'not a password field'
          : 'typing shown',
    );
  if (seen.noEchoAfterSubmit !== undefined) parts.push(seen.noEchoAfterSubmit.value ? 'no echo' : 'value echoed');
  if (seen.navigatedAway !== undefined) parts.push(seen.navigatedAway.value ? 'moved on' : 'stayed');
  if (seen.secondFactor !== undefined) parts.push(FACTOR_WORDS[seen.secondFactor.value]);
  const counts = [seen.masked, seen.noEchoAfterSubmit, seen.navigatedAway, seen.secondFactor].filter(
    (fact): fact is NonNullable<typeof fact> => fact !== undefined,
  );
  const times = counts.length === 0 ? 0 : Math.min(...counts.map(fact => fact.count));
  const last = counts
    .map(fact => fact.observedAt)
    .sort()
    .at(-1);
  const when = last === undefined ? '' : ` (seen ${String(times)}×, ${last.slice(0, 10)})`;
  return `${seen.at}: ${parts.length === 0 ? 'nothing yet' : parts.join(', ')}${when}`;
}
