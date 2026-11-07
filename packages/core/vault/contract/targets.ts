import { defineHook, type FerretId, type TargetKind, type TargetRef } from '@ferretry/kernel/contract';
import { NonNegativeIntegerSchema, PositiveIntegerSchema } from '@ferretry/std';
import { z } from 'zod';
import { SecretNameSchema } from './secrets.ts';

/**
 * The `input.targets` kind (§4.7): how the Vault types an owner's value into a tool's target. A tool plugin provides
 * the hook under its target kind; only Terminals (`terminal`) and Browsers (`page`) may (security path). The facts
 * schemas are today's `protocol/src/lib/input-request.ts`, field for field, with `browser` renamed `page`; they live
 * here because the offering subsystem's contract defines the kind (§4).
 */

export const TARGET_KINDS = ['terminal', 'page'] as const;
export const TargetKindSchema = z.enum(TARGET_KINDS);
export type InputTargetKind = z.infer<typeof TargetKindSchema>;

export const targetKind = (kind: InputTargetKind): TargetKind => kind as string as TargetKind;
export const targetRef = (kind: InputTargetKind, key: string): TargetRef => ({ kind: targetKind(kind), key });

const boundedLine = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'must be one line with no control characters');

const Digest = z.string().regex(/^[0-9a-f]{64}$/u, 'a sha-256 digest in lowercase hex');

/** A terminal or page name or id (today's `SurfaceKeySchema`, with the `%terminal:` / `%browser:` prefix stripped). */
export const SurfaceKeySchema = z
  .string()
  .trim()
  .transform(value => value.replace(/^%(?:terminal|browser):/u, ''))
  .pipe(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u, 'not a surface name or id'));

/** Where a value goes: a terminal, a page, or the Vault's own store (a secure-copy paste). */
export const InputTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('terminal'), key: SurfaceKeySchema }),
  z.strictObject({ kind: z.literal('page'), key: SurfaceKeySchema }),
  z.strictObject({ kind: z.literal('secret'), key: SecretNameSchema }),
]);
export type InputTarget = z.infer<typeof InputTargetSchema>;

// ─── facts ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const InputPaneProofSchema = z.strictObject({
  paneId: z.string().regex(/^%(?:0|[1-9][0-9]*)$/u),
  pid: PositiveIntegerSchema,
  sessionCreated: PositiveIntegerSchema.optional(),
});
export const InputEchoSchema = z.enum(['off', 'on', 'unknown']);
export const InputForegroundSchema = z.strictObject({
  pid: PositiveIntegerSchema,
  pgid: PositiveIntegerSchema,
  comm: boundedLine(64),
  argv: z
    .string()
    .max(200)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u),
});

export const TerminalFactsSchema = z.strictObject({
  kind: z.literal('terminal'),
  paneProof: InputPaneProofSchema,
  foreground: InputForegroundSchema,
  echo: InputEchoSchema,
  cursorRow: NonNegativeIntegerSchema,
  promptLine: z
    .string()
    .max(200)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u),
  promptLineDigest: Digest,
  program: boundedLine(64).optional(),
  recognisedConsumer: z.boolean(),
  canonical: z.boolean().optional(),
  trustedProgram: z.literal(true).optional(),
});
export type TerminalFacts = z.infer<typeof TerminalFactsSchema>;

export const InputFieldIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/u, 'a field id is a short lowercase word: letters, digits and underscores');

const PageFieldSchema = z.strictObject({
  tag: boundedLine(32),
  type: boundedLine(32).optional(),
  autocomplete: boundedLine(64).optional(),
  name: boundedLine(128).optional(),
  id: boundedLine(128).optional(),
  inputmode: boundedLine(32).optional(),
});

export const PageFieldFactsSchema = z.strictObject({
  fieldId: InputFieldIdSchema,
  frameOrigin: boundedLine(256),
  frameId: boundedLine(128),
  backendNodeId: PositiveIntegerSchema,
  field: PageFieldSchema,
  box: z.strictObject({
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite().nonnegative(),
    h: z.number().finite().nonnegative(),
  }),
  visible: z.boolean(),
  covered: z.literal(true).optional(),
});
export type PageFieldFacts = z.infer<typeof PageFieldFactsSchema>;

export const INPUT_MAX_FIELDS = 4;
export const PageChallengeProviderSchema = z.enum([
  'cloudflare',
  'recaptcha',
  'hcaptcha',
  'google',
  'datadome',
  'arkose',
  'perimeterx',
  'other',
]);

export const PageFactsSchema = z.strictObject({
  kind: z.literal('page'),
  pageId: boundedLine(128),
  origin: boundedLine(256),
  secure: z.boolean(),
  navigationId: boundedLine(128),
  fields: z.array(PageFieldFactsSchema).min(1).max(INPUT_MAX_FIELDS),
  challenge: z.strictObject({ provider: PageChallengeProviderSchema }).optional(),
});
export type PageFacts = z.infer<typeof PageFactsSchema>;

export const SecretStoreFactsSchema = z.strictObject({
  kind: z.literal('secret'),
  name: SecretNameSchema,
  exists: z.boolean(),
});

/** WHAT THE DAEMON SAW at the target, drawn large on the card; re-observed before it types. */
export const InputTargetFactsSchema = z.discriminatedUnion('kind', [
  TerminalFactsSchema,
  PageFactsSchema,
  SecretStoreFactsSchema,
]);
export type InputTargetFacts = z.infer<typeof InputTargetFactsSchema>;

// ─── the adapter ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A program proved to be reading the target (today's `ProfileProgram`). */
export interface ProfileProgram {
  readonly name: string;
  readonly path: string;
}

/** Today's `ObserveResult`. */
export type ObserveResult<F extends InputTargetFacts = InputTargetFacts> =
  | {
      readonly ok: true;
      readonly facts: F;
      readonly names?: readonly string[];
      readonly codeProgram?: true;
      readonly profileProgram?: ProfileProgram;
    }
  | { readonly ok: false; readonly reason: 'target_gone' | 'unsupported' };

/** A provider whose own sign-in page shows a push number (today's `push-number.ts`). */
export type PushNumberProvider = 'okta' | 'microsoft' | 'google' | 'duo';

/**
 * One look at a page for the number a push approval shows (today's `BrowserPushNumberRead`, docs/input-requests.md,
 * "Approve on your phone"), as the BROWSER answers it: where the page is (its origin and document, read before and
 * after the look), which provider's challenge the document is when one's document test held, and the number when one
 * was found. The reader decides whether to believe it (the origin and the session's scripts); the browser only reads.
 */
export interface PushNumberRead {
  /** `scheme://host[:port]` of the page, from the browser. */
  readonly origin: string;
  /** The document the look was made in, read before it; a different one after is `missing: 'changed'`. */
  readonly navigationId: string;
  /** The provider whose challenge this document is, when its document test held (with or without a number). */
  readonly provider?: PushNumberProvider;
  /** The number: 1 to 6 digits, from the provider's own view, visible and no one can type into, in the main frame. */
  readonly number?: { readonly value: string; readonly from: PushNumberProvider; readonly frameOrigin: string };
  /** Why there is no number: none recognised, or the page changed meanwhile. */
  readonly missing?: 'none-found' | 'changed';
}

/** Today's `TypeResult`. */
export type TypeResult = 'typed' | 'target_gone' | 'target_changed' | 'uncertain' | 'guard_refused' | 'reader_changed';

/** One card field as the adapter is asked to find it: a page field names its element (selector or snapshot ref). */
export interface InputTargetField {
  readonly id: string;
  readonly element?:
    | { readonly kind: 'selector'; readonly selector: string }
    | { readonly kind: 'ref'; readonly ref: string };
}

/** One value to type. Held only for the write; never logged, never kept. */
export interface InputFieldValue {
  readonly field: string;
  readonly text: string;
}

/** Today's `TypeOptions`. */
export interface TypeOptions {
  readonly codeProgram?: boolean;
  readonly profileProgram?: ProfileProgram;
  readonly armClear?: boolean | 'try';
  readonly armed?: (armed: boolean) => void;
  /** Asked synchronously right before the write; false types nothing. */
  readonly proceed?: () => boolean;
  readonly reprove?: boolean;
}

/** A picture of the target for the card (a page only; a terminal's card draws its own text). */
export interface InputShot {
  readonly pngBase64: string;
  readonly clip: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/** What a page is asked to check and empty before a hold ends (today's `ClearJob`). */
export interface ClearJob {
  readonly navigationId: string;
  readonly fields: readonly { readonly frameId: string; readonly backendNodeId: number }[];
}
export type ClearOutcome = 'cleared' | 'moved' | 'unknown';

/**
 * The value of `input.targets:<kind>` (§4.7; today's `InputTargetPort`): `observe` (the facts the card shows),
 * `refind`, `type` (one write into the observed field, under the binding check), `arm` (clear-on-leave where it can,
 * today's `clear`). The rest are today's optional page abilities. Every call names the ferret the card is for.
 */
export interface InputTargetAdapter {
  /** What it can mask: `text`, terminal `cells`, or `pixels` (cannot mask; always the full hold). */
  readonly masking: 'text' | 'cells' | 'pixels';
  observe(ferret: FerretId, target: InputTarget, fields: readonly InputTargetField[]): Promise<ObserveResult>;
  refind?(
    ferret: FerretId,
    target: InputTarget,
    fields: readonly InputTargetField[],
    expected: InputTargetFacts,
  ): Promise<ObserveResult>;
  type(
    ferret: FerretId,
    target: InputTarget,
    values: readonly InputFieldValue[],
    submit: boolean,
    expected: InputTargetFacts,
    options?: TypeOptions,
  ): Promise<TypeResult>;
  arm?(ferret: FerretId, target: InputTarget, job: ClearJob): Promise<ClearOutcome>;
  shoot?(ferret: FerretId, target: InputTarget, facts: InputTargetFacts): Promise<InputShot | undefined>;
  document?(ferret: FerretId, key: string): Promise<string | undefined>;
  /**
   * The login observer's looks after a submit (today's `InputLoginProbe` over a page's and a terminal's own reads):
   * `where` is a page's document and host now; `text` is what a ferret's read of the target could return (a page's text,
   * a terminal's screen), which the Vault only searches for the typed values and never keeps; `promptLine` is a
   * terminal's line at its cursor. Each is pinned to `surfaces`, the names the typed-into target had: another surface
   * under the key answers nothing. An adapter that offers none leaves every sign-in fact unknown.
   */
  where?(
    ferret: FerretId,
    key: string,
    surfaces: readonly string[],
  ): Promise<{ readonly navigationId: string; readonly host: string } | undefined>;
  text?(ferret: FerretId, key: string, surfaces: readonly string[]): Promise<string | undefined>;
  promptLine?(ferret: FerretId, key: string, surfaces: readonly string[]): Promise<string | undefined>;
  probe?(
    ferret: FerretId,
    target: InputTarget,
    facts: InputTargetFacts,
    fieldIds: readonly string[],
  ): Promise<'hidden' | 'shown' | 'aborted'>;
  /**
   * Phone approval's look (today's `PageInputTarget.pushNumber`): the push number the ferret's page `key` shows now,
   * read in the page's own queue from a provider's own challenge view only, never an element a ferret points at, with
   * the page's id so a page opened again under the name is told apart. Nothing when the page is gone or this target
   * cannot read one. Accounts' phone approval reaches the page through this, not through a Browsers import.
   */
  pushNumber?(
    ferret: FerretId,
    key: string,
  ): Promise<{ readonly pageId: string; readonly read: PushNumberRead } | undefined>;
}

export const InputTargets = defineHook('input.targets', {
  mode: 'provide',
  key: TargetKindSchema,
  value: z.custom<InputTargetAdapter>(),
  takers: ['terminals', 'browsers'],
});
