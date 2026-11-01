import { z } from 'zod';
import { BrowserRefSchema } from './browser-target.ts';
import { InstantSchema, NonNegativeIntegerSchema } from './common.ts';
import { SurfaceKeySchema } from './surface-names.ts';

/**
 * SECURE COPY: a value the agent asked the daemon to capture and may only ever name (docs/secure-copy.md).
 *
 * The agent says WHERE a value is — a page element, the page's clipboard after the page's own Copy button, or
 * what a command prints — and the daemon reads it into memory under a handle, `sealed:<name>`. The agent is
 * told what the daemon saw about it (where it came from, how long it is, when it lapses), never the value.
 * Pasting it is an input request whose value comes from the handle (docs/input-requests.md).
 *
 * ## NO SCHEMA HERE HAS A FIELD FOR THE VALUE
 *
 * A capture request, a copy's description and a listing say where a value came from and what became of it.
 * `tests/unit/secure-copy.test.ts` fails if any of them gains a field named or shaped like a value. The one
 * value-adjacent fact is `length`: the brief makes it visible so the agent can tell a capture caught
 * something, and it is a count, never a prefix, a digest or a character class.
 */

/** How long a copy lives when the agent names no time, and the most it may ask for. */
export const COPY_DEFAULT_LIFETIME_SECONDS = 3_600;
export const COPY_MAX_LIFETIME_SECONDS = 14_400;
/** How long a copy stays masked after it is discarded or lapses: it may still be on a screen it was pasted to. */
export const COPY_AFTER_MASK_SECONDS = 600;
/** Per session: copies alive at once, and captures an hour. */
export const COPY_MAX_LIVE_PER_SESSION = 10;
export const COPY_MAX_CAPTURES_PER_HOUR = 20;
/** The longest value a copy holds, in UTF-8 bytes. */
export const COPY_VALUE_MAX_BYTES = 16_384;
/** The shortest value a copy holds: a shorter one would be masked wherever it appears and read as "seen" by chance. */
export const COPY_VALUE_MIN_CHARS = 4;
/** A command capture: at most this many arguments, each this long, and this long to run. */
export const COPY_COMMAND_MAX_ARGS = 64;
export const COPY_COMMAND_MAX_ARG_CHARS = 4_096;
export const COPY_COMMAND_DEFAULT_TIMEOUT_SECONDS = 30;
export const COPY_COMMAND_MAX_TIMEOUT_SECONDS = 60;
/** What a command printed on stderr, masked, that the agent is handed back so it can tell why it failed. */
export const COPY_STDERR_MAX_CHARS = 2_048;
/** The prefix a handle is written with. */
export const COPY_HANDLE_PREFIX = 'sealed:';

const boundedLine = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'must be one line with no control characters');

/** A copy's name, chosen by the agent: a lowercase letter, then lowercase letters, digits, `_` or `-`. */
export const COPY_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/u;
export const CopyNameSchema = z
  .string()
  .regex(COPY_NAME_PATTERN, 'a copy name is a lowercase letter, then up to 39 lowercase letters, digits, _ or -');
export type CopyName = z.infer<typeof CopyNameSchema>;

/** How a call names an existing copy: `sealed:<name>` as the agent was told it, or the bare name. */
export const CopyHandleSchema = z
  .string()
  .trim()
  .transform(value => (value.startsWith(COPY_HANDLE_PREFIX) ? value.slice(COPY_HANDLE_PREFIX.length) : value))
  .pipe(CopyNameSchema);

/** The handle an agent is told to write for a copy. */
export const copyHandle = (name: CopyName): string => `${COPY_HANDLE_PREFIX}${name}`;

/** What part of an element is read: its visible text, a form field's current value, or one attribute. */
export const CopyElementPartSchema = z.enum(['text', 'value', 'attribute']);
export type CopyElementPart = z.infer<typeof CopyElementPartSchema>;

/**
 * WHERE THE VALUE IS, as the agent says it. Nothing here was observed: the daemon reads the element, the
 * clipboard or the command's output itself, and records where it really came from.
 *
 * - `browser`: one element of a page the agent may act on, by `ref` (from a snapshot) or `selector`.
 * - `clipboard`: the page's clipboard, read after the agent pressed the page's own Copy button. Only the
 *   agent browser's own clipboard, for that page's origin; never this computer's system clipboard.
 * - `command`: a program the daemon runs (no shell) with the session's folder as its working folder. Its
 *   stdout is the value; it is never handed back.
 */
export const CopySourceSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('browser'),
      key: SurfaceKeySchema,
      ref: BrowserRefSchema.optional(),
      selector: boundedLine(512).optional(),
      read: CopyElementPartSchema.default('text'),
      attribute: z
        .string()
        .regex(/^[A-Za-z_:][A-Za-z0-9_:.-]{0,63}$/u, 'an attribute name')
        .optional(),
    })
    .superRefine((source, context) => {
      if ((source.ref === undefined) === (source.selector === undefined))
        context.addIssue({ code: 'custom', message: 'name the element by ref or by selector, exactly one' });
      if ((source.read === 'attribute') !== (source.attribute !== undefined))
        context.addIssue({ code: 'custom', message: 'read "attribute" names an attribute, and only then' });
    }),
  z.strictObject({ kind: z.literal('clipboard'), key: SurfaceKeySchema }),
  z.strictObject({
    kind: z.literal('command'),
    /** The program and its arguments, run as they are: no shell, so no `|`, `$()` or globbing. */
    argv: z.array(z.string().min(1).max(COPY_COMMAND_MAX_ARG_CHARS)).min(1).max(COPY_COMMAND_MAX_ARGS),
    /** Absolute, or relative to the session's own folder (the default). */
    cwd: z.string().trim().min(1).max(1_024).optional(),
    timeoutSeconds: z.number().int().min(1).max(COPY_COMMAND_MAX_TIMEOUT_SECONDS).optional(),
    /** Drop leading and trailing white space (a token's trailing newline): on by default. */
    trim: z.boolean().optional(),
  }),
]);
export type CopySource = z.infer<typeof CopySourceSchema>;
export type CopySourceKind = CopySource['kind'];

/** `secure.copy`: capture a value under a name. */
export const CopyCaptureSchema = z.strictObject({
  name: CopyNameSchema,
  source: CopySourceSchema,
  expiresInSeconds: z.number().int().min(60).max(COPY_MAX_LIFETIME_SECONDS).optional(),
});
export type CopyCapture = z.infer<typeof CopyCaptureSchema>;

/**
 * WHERE A COPY CAME FROM, as the daemon saw it: the page's origin (from the browser, never the agent) or the
 * program's base name. Never the arguments, never a URL path.
 */
export const CopyOriginSchema = z.strictObject({
  kind: z.enum(['browser', 'clipboard', 'command']),
  /** `scheme://host[:port]` of the page, for a page or clipboard copy. */
  origin: boundedLine(256).optional(),
  /** The program's base name, for a command copy. */
  program: boundedLine(64).optional(),
  /**
   * The file that ran, for a command copy: found by the daemon on the command's PATH, so the owner sees WHICH
   * `vercel` printed the value (`/usr/local/bin/vercel`, or one in a folder the ferret could have written to).
   */
  path: boundedLine(1024).optional(),
  /**
   * The account the daemon (and every ferret) runs as could change that file or put another in its place: its
   * file or its folder is writable. A pre-approval rule never matches such a program; the owner is asked.
   */
  replaceable: z.literal(true).optional(),
  /**
   * A page copy of a form field's VALUE: whatever was typed into it, by the agent too, so it says nothing about
   * the page that holds it. A pre-approval rule never matches it; the owner is asked.
   */
  editable: z.literal(true).optional(),
  /** The surface it was read from, for a page or clipboard copy. */
  surface: SurfaceKeySchema.optional(),
});
export type CopyOrigin = z.infer<typeof CopyOriginSchema>;

/**
 * Whether the agent may ALREADY have seen the value before it was sealed, said honestly:
 * - `transcript`: the daemon looked for the value in the session's own transcript when it captured it.
 *   `found` means it is in the agent's context and is NOT protected; `clean` means it was not in the part of
 *   the transcript the daemon read; `unknown` means the transcript could not be read.
 * - `pageReadBeforeCapture`: the agent read, screenshotted or evaluated this page since it last navigated.
 */
export const CopyExposureSchema = z.strictObject({
  transcript: z.enum(['clean', 'found', 'unknown']),
  pageReadBeforeCapture: z.boolean().optional(),
});
export type CopyExposure = z.infer<typeof CopyExposureSchema>;

/** Where a copy stands. Only `live` can be pasted. A daemon restart lets go of every copy: it is then not listed at all. */
export const CopyStateSchema = z.enum(['live', 'discarded', 'expired']);
export type CopyState = z.infer<typeof CopyStateSchema>;

/**
 * EVERYTHING AN AGENT IS EVER TOLD ABOUT A COPY. `length` is in characters; `lines` counts line breaks plus
 * one. A command copy also says how the command ended and what it printed on stderr, masked.
 */
export const CopyMetaSchema = z.strictObject({
  handle: z.string().regex(/^sealed:[a-z][a-z0-9_-]{0,39}$/u),
  name: CopyNameSchema,
  from: CopyOriginSchema,
  length: NonNegativeIntegerSchema,
  lines: NonNegativeIntegerSchema,
  capturedAt: InstantSchema,
  expiresAt: InstantSchema,
  state: CopyStateSchema,
  exposure: CopyExposureSchema,
  /** How many times it has been pasted. */
  uses: NonNegativeIntegerSchema,
});
export type CopyMeta = z.infer<typeof CopyMetaSchema>;

/** How a command capture ended, for the agent to act on: never stdout. */
export const CopyCommandReportSchema = z.strictObject({
  outcome: z.enum(['exited', 'timeout', 'spawn_failed']),
  exitCode: z.number().int().optional(),
  /** stderr through the vault redactor and with the would-be value masked, cut to {@link COPY_STDERR_MAX_CHARS}. */
  stderr: z.string().max(COPY_STDERR_MAX_CHARS).optional(),
});
export type CopyCommandReport = z.infer<typeof CopyCommandReportSchema>;

/** The marker a copy is masked with wherever the daemon scrubs text. */
export const copyMask = (name: CopyName): string => `[sealed:${name}]`;

// ── Pasting, and approving pastes in advance ───────────────────────────────────────────────────────────

/** How long a pre-approval rule may live, how many pastes one may allow, and how many rules the daemon keeps. */
export const COPY_RULE_MAX_LIFETIME_SECONDS = 30 * 24 * 3_600;
export const COPY_RULE_MAX_COUNT = 100;
export const COPY_MAX_RULES = 50;
/** A plan card: at most this many planned pastes, each said in at most this many characters, waiting this long. */
export const COPY_PLAN_MAX_ITEMS = 10;
export const COPY_PLAN_WHY_MAX_CHARS = 140;
export const COPY_PLAN_DEFAULT_LIFETIME_SECONDS = 7_200;
/** The longest an agent may ask a plan's rules to last; a longer route is the owner's to add as a rule. */
export const COPY_PLAN_MAX_LIFETIME_SECONDS = 86_400;

/** A program as the daemon names it: a base name, no path. tmux reports at most 15 characters of it on Linux. */
const ProgramSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._+-]+$/u, 'a program base name, like vercel or gh');
/** `scheme://host[:port]`, as the browser reports a page's origin. */
const OriginSchema = z
  .string()
  .max(256)
  .regex(/^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u, 'an origin, like https://github.com');
const SecretStoreNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u, 'a secret name, like VERCEL_TOKEN');

/** Where a paste's value comes FROM, as a rule or a plan names it: a program, or a page's origin. */
export const CopyRouteFromSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('command'), program: ProgramSchema }),
  z.strictObject({ kind: z.literal('browser'), origin: OriginSchema }),
  z.strictObject({ kind: z.literal('clipboard'), origin: OriginSchema }),
]);
export type CopyRouteFrom = z.infer<typeof CopyRouteFromSchema>;

/**
 * Where a paste GOES: the program reading a terminal, a page's origin, or a secret-store name. A rule for the
 * secret store names the EXACT secret: no rule can write a secret it does not name (docs/secure-copy.md).
 */
export const CopyRouteToSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('terminal'), program: ProgramSchema }),
  z.strictObject({ kind: z.literal('browser'), origin: OriginSchema }),
  z.strictObject({ kind: z.literal('secret'), name: SecretStoreNameSchema }),
]);
export type CopyRouteTo = z.infer<typeof CopyRouteToSchema>;

/** Who approved a rule: the owner at the machine, or a paired device. */
const RuleOwnerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host') }),
  z.strictObject({ kind: z.literal('device'), deviceId: boundedLine(128) }),
]);

const RuleIdSchema = z.string().regex(/^[0-9a-f]{32}$/u, 'a 128-bit hex id');
export const CopyPlanIdSchema = z.string().regex(/^[0-9a-f]{32}$/u, 'a 128-bit hex id');

/**
 * A PRE-APPROVAL RULE: the owner allowed, in advance, pastes from this source to this destination. Matched on
 * what the DAEMON observed (the copy's program or origin, the destination's program or origin), never on the
 * agent's words. Each paste it allows is still raised, audited and shown in the log.
 */
export const PasteRuleSchema = z.strictObject({
  id: RuleIdSchema,
  from: CopyRouteFromSchema,
  to: CopyRouteToSchema,
  /** Only this session's pastes, or any session's. */
  sessionId: boundedLine(128).optional(),
  expiresAt: InstantSchema.optional(),
  /** Pastes it still allows; absent means no count. */
  remaining: z.number().int().min(0).max(COPY_RULE_MAX_COUNT).optional(),
  used: NonNegativeIntegerSchema,
  createdAt: InstantSchema,
  createdBy: RuleOwnerSchema,
  /** The plan card it came from, when the ferret asked first. */
  plan: CopyPlanIdSchema.optional(),
});
export type PasteRule = z.infer<typeof PasteRuleSchema>;

/** `POST /v1/copy-rules`: the owner approves a route in advance. */
export const PasteRuleCreateSchema = z.strictObject({
  from: CopyRouteFromSchema,
  to: CopyRouteToSchema,
  sessionId: boundedLine(128).optional(),
  expiresInSeconds: z.number().int().min(60).max(COPY_RULE_MAX_LIFETIME_SECONDS).optional(),
  count: z.number().int().min(1).max(COPY_RULE_MAX_COUNT).optional(),
});
export type PasteRuleCreate = z.infer<typeof PasteRuleCreateSchema>;

/**
 * The owner's secure-copy settings, kept beside the rules. `allowProfileTargets` ("Copy rules may target programs in
 * my own profile", owner decision !A182): a `terminal:<program>` rule may also match a program reached through the
 * owner's own Nix profile (`~/.nix-profile`), which every process running as the owner, every ferret included, can
 * change. OFF unless the owner turns it on; turning it on LOOSENS, so a remote device needs a passkey for it.
 */
export const PasteRuleSettingsSchema = z.strictObject({ allowProfileTargets: z.boolean() });
export type PasteRuleSettings = z.infer<typeof PasteRuleSettingsSchema>;
export const DEFAULT_PASTE_RULE_SETTINGS: PasteRuleSettings = { allowProfileTargets: false };

/** `GET /v1/copy-rules`. */
export const PasteRuleListSchema = z.strictObject({ rules: z.array(PasteRuleSchema).max(COPY_MAX_RULES) });
export type PasteRuleList = z.infer<typeof PasteRuleListSchema>;

/**
 * `GET /v1/copy-rules/settings`: the settings and the rules a program from the owner's profile could stand for. A route
 * of its own, so the rules list an older app parses strictly is unchanged; an app that gets no answer from an older
 * daemon shows no setting and no badge.
 */
export const PasteRuleSettingsViewSchema = z.strictObject({
  settings: PasteRuleSettingsSchema,
  /**
   * The terminal rules a program from the owner's own profile COULD satisfy: no root-controlled folder holds that
   * program, and it is no password or code program. Each is shown as "your profile — a ferret could swap this
   * program". Worked out when asked, never stored.
   */
  profileRules: z.array(RuleIdSchema).max(COPY_MAX_RULES),
});
export type PasteRuleSettingsView = z.infer<typeof PasteRuleSettingsViewSchema>;

/**
 * Programs that run whatever they read: a shell or an interpreter. A rule that pastes into one hands the value to
 * whatever the ferret typed before it, so the rule editor and `fy copy rules add` warn about it.
 */
const RUNS_WHAT_IT_READS = new Set([
  'bash',
  'sh',
  'ash',
  'dash',
  'ksh',
  'mksh',
  'csh',
  'tcsh',
  'zsh',
  'fish',
  'nu',
  'xonsh',
  'elvish',
  'pwsh',
  'powershell',
  'busybox',
  'node',
  'bun',
  'deno',
  'perl',
  'ruby',
  'irb',
  'php',
  'lua',
  'luajit',
  'tclsh',
  'wish',
  'expect',
  'awk',
  'gawk',
  'R',
  'julia',
  'ghci',
  'osascript',
]);

/** Whether a rule's terminal program is a shell or an interpreter (`python`, `python3.12`, `pypy3` too). */
export const runsWhatItReads = (program: string): boolean => {
  const trimmed = program.trim();
  const name = trimmed.toLowerCase();
  return RUNS_WHAT_IT_READS.has(trimmed) || RUNS_WHAT_IT_READS.has(name) || /^(?:python|pypy)[0-9.]*$/u.test(name);
};

/** What the rule editor and the CLI say about such a rule. */
export const RUNS_WHAT_IT_READS_WARNING = 'This program runs whatever it reads: a paste into it can run as a command.';

/** One paste a ferret plans, said before it starts. `why` is the agent's own words, shown as such. */
export const CopyPlanItemSchema = z.strictObject({
  from: CopyRouteFromSchema,
  to: CopyRouteToSchema,
  why: z
    .string()
    .trim()
    .min(1)
    .max(COPY_PLAN_WHY_MAX_CHARS)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u),
});
export type CopyPlanItem = z.infer<typeof CopyPlanItemSchema>;

export const CopyPlanStateSchema = z.enum(['pending', 'approved', 'declined', 'expired']);

/**
 * A FERRET'S PLAN of pastes, on one card: the owner ticks the ones it allows, and each becomes a rule for THIS
 * session that allows one paste, until the plan's expiry. Nothing in it is a value.
 */
export const CopyPlanSchema = z.strictObject({
  id: CopyPlanIdSchema,
  sessionId: boundedLine(128),
  agendaItemId: boundedLine(16),
  items: z.array(CopyPlanItemSchema).min(1).max(COPY_PLAN_MAX_ITEMS),
  state: CopyPlanStateSchema,
  raisedAt: InstantSchema,
  expiresAt: InstantSchema,
  /** The items the owner allowed, by index. */
  approved: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(COPY_PLAN_MAX_ITEMS - 1),
    )
    .max(COPY_PLAN_MAX_ITEMS)
    .optional(),
});
export type CopyPlan = z.infer<typeof CopyPlanSchema>;

/** `GET /v1/copy-plans`: the plans still waiting. */
export const CopyPlanListSchema = z.strictObject({ plans: z.array(CopyPlanSchema).max(100) });
export type CopyPlanList = z.infer<typeof CopyPlanListSchema>;

/** `POST /v1/sessions/:sessionId/copy-plans/:planId/approve`: which items, by index. An empty list declines. */
export const CopyPlanApproveSchema = z.strictObject({
  items: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(COPY_PLAN_MAX_ITEMS - 1),
    )
    .max(COPY_PLAN_MAX_ITEMS),
});
export type CopyPlanApprove = z.infer<typeof CopyPlanApproveSchema>;
