/**
 * The daemon-scoped secret store, as the wire describes it.
 *
 * READ THE PROPERTY THIS SURFACE ACTUALLY HAS, because it is narrower than "agents cannot see
 * secrets" and someone who believes the wider claim will hand an untrusted agent a production
 * credential.
 *
 * WHAT IT GUARANTEES:
 *
 * - **There is no schema here that carries a secret value out of the daemon.** `SecretSummarySchema`
 *   is name and timestamps; `SecretUseResultSchema` is a child process's redacted output. A value
 *   travels IN on `PutSecretRequestSchema` and never travels back. That is the load-bearing rule of
 *   the whole design, and it is enforced by the absence of a getter rather than by a check — there is
 *   nothing to forget to call.
 * - **Configuration holds a reference, never a value.** `SECRET_REFERENCE_PATTERN` is the ONE grammar;
 *   a second spelling would be a value that silently failed to resolve.
 * - **The agent process never holds the value.** `SecretUseRequestSchema` names secrets by reference;
 *   the daemon puts them in the environment of the CHILD it spawns and returns that child's output.
 *   An agent that only ever writes the reference has nothing to echo.
 *
 * WHAT IT DOES NOT GUARANTEE:
 *
 * - **An agent that is actively trying to exfiltrate a secret it may use will succeed.** It can run
 *   `sh -c 'echo $KEY | base64'` and read the transform out of the output. Redaction scrubs the
 *   literal value and cannot recognise what it cannot match. The boundary is the one `sudo` has: it
 *   stops accidents and casual reading, not a determined holder of the capability.
 * - It is not protection against someone who already has the user account the daemon runs as.
 */

import { z } from 'zod';
import { InstantSchema } from './common.ts';

export const SECRET_SCHEMA_VERSION = 1 as const;

/** Longest secret name. Bounded because a name is rendered in listings and in refusal messages. */
export const MAX_SECRET_NAME_LENGTH = 64;

/** Most secrets one daemon will hold. A bound keeps the store a document rather than a database. */
export const MAX_SECRETS_PER_DAEMON = 256;

/**
 * Shortest value the store accepts.
 *
 * IT IS A REDACTION CONSTRAINT, NOT A STRENGTH POLICY. Redaction works by finding the literal value
 * in text; a three-character value would match inside ordinary prose and mask half the transcript,
 * and a one-character value would mask nearly all of it. A value this store cannot scrub safely is a
 * value whose central promise it cannot keep, so it is refused at the boundary with that reason
 * rather than accepted and quietly left out of redaction.
 */
export const MIN_SECRET_VALUE_LENGTH = 8;

/** Longest value. Generous enough for a PEM private key, bounded so the document stays a document. */
export const MAX_SECRET_VALUE_LENGTH = 16 * 1024;

/**
 * A secret's name.
 *
 * Deliberately the shape of a POSIX environment variable name, because that is what a name becomes
 * when it is used: the daemon exports it into a spawned child's environment. Restricting it here
 * means no name can ever be rejected later by the thing that has to consume it, and no name needs
 * quoting anywhere it is rendered.
 */
export const SecretNameSchema = z
  .string()
  .min(1)
  .max(MAX_SECRET_NAME_LENGTH)
  .regex(/^[A-Z][A-Z0-9_]*$/u, 'a secret name is uppercase letters, digits and underscores');
export type SecretName = z.infer<typeof SecretNameSchema>;

/**
 * A secret's value, on its way IN.
 *
 * There is no schema for a value on its way out, and that is the point — see this file's header.
 * Not trimmed: leading or trailing whitespace can be load-bearing in a key, and silently altering a
 * credential produces a failure whose cause is invisible.
 */
export const SecretValueSchema = z.string().min(MIN_SECRET_VALUE_LENGTH).max(MAX_SECRET_VALUE_LENGTH);

/**
 * Everything a client may learn about a stored secret: THAT it exists, what it is called, and when it
 * last changed. No value, no length, no digest — a length narrows a guess and a digest is an offline
 * cracking target, and neither buys the person at the screen anything.
 */
export const SecretSummarySchema = z
  .object({
    name: SecretNameSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  })
  .strict();
export type SecretSummary = z.infer<typeof SecretSummarySchema>;

/**
 * Where a reference to a secret was found in this daemon's configuration, and whether it resolves.
 *
 * The point of surfacing it is that an unresolved reference is a launch that WILL fail, and the
 * person can see it before it does rather than reading a confusing error from a child process much
 * later.
 */
export const SecretReferenceViewSchema = z
  .object({
    name: SecretNameSchema,
    /** Human-readable origin, e.g. `config/daemon.json → agentEnvironment.API_BASE`. */
    origin: z.string().min(1),
    /** False when no secret of this name exists; the launch that reads it will refuse. */
    resolved: z.boolean(),
  })
  .strict();
export type SecretReferenceView = z.infer<typeof SecretReferenceViewSchema>;

/**
 * How a store answers "what have you got".
 *
 * `damaged` is NOT an empty list. A store whose document will not parse, or whose key is gone while
 * ciphertext remains, knows only that it cannot answer — and a UI told "no secrets" would invite the
 * person to recreate every one of them over a file that is still there. It is reported as its own
 * state so the surface can say so.
 */
export const SecretStoreHealthSchema = z.enum(['ready', 'damaged']);
export type SecretStoreHealth = z.infer<typeof SecretStoreHealthSchema>;

export const SecretListSchema = z
  .object({
    v: z.literal(SECRET_SCHEMA_VERSION),
    health: SecretStoreHealthSchema,
    /** Why the store is damaged, in terms an operator can act on. Present only when damaged. */
    diagnosis: z.string().min(1).optional(),
    secrets: z.array(SecretSummarySchema).max(MAX_SECRETS_PER_DAEMON).readonly(),
    references: z.array(SecretReferenceViewSchema).readonly(),
  })
  .strict();
export type SecretList = z.infer<typeof SecretListSchema>;

/** What a delete answers. The name is echoed so a client can confirm WHICH secret went, and
 *  `removed` is a literal `true` because a 404 is how "there was none" is reported. */
export const RemovedSecretSchema = z.object({ name: SecretNameSchema, removed: z.literal(true) }).strict();
export type RemovedSecret = z.infer<typeof RemovedSecretSchema>;

/** Creating a secret, or replacing one that exists. There is no distinct edit: a value is opaque. */
export const PutSecretRequestSchema = z
  .object({
    name: SecretNameSchema,
    value: SecretValueSchema,
  })
  .strict();
export type PutSecretRequest = z.infer<typeof PutSecretRequestSchema>;

/**
 * THE ONE reference grammar. `${secret:NAME}` anywhere a value is configured.
 *
 * Chosen to be shell-shaped so it reads as a substitution to anyone who sees it, and `secret:`-tagged
 * so it can never be confused with an ordinary `${VAR}` a shell might expand. A second spelling would
 * be a reference that silently stayed literal, which is the failure this constant exists to make
 * impossible — so match on this and nothing else.
 *
 * Not a global regex object: a shared `lastIndex` across callers is a classic intermittent bug. Use
 * {@link secretReferencePattern} for a fresh one.
 */
export const SECRET_REFERENCE_SOURCE = '\\$\\{secret:([A-Z][A-Z0-9_]{0,63})\\}';

/** A fresh global matcher for the reference grammar; never share one, `lastIndex` is state. */
export function secretReferencePattern(): RegExp {
  return new RegExp(SECRET_REFERENCE_SOURCE, 'gu');
}

/** How a value referencing `name` is spelled in configuration. */
export function secretReference(name: SecretName): string {
  return `\${secret:${name}}`;
}

/** Every distinct secret named by a configured value, in first-appearance order. */
export function secretReferencesIn(value: string): readonly SecretName[] {
  const seen: SecretName[] = [];
  for (const match of value.matchAll(secretReferencePattern())) {
    const name = match[1];
    if (name !== undefined && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

/**
 * A `${secret:` opener in `value` that is NOT a well-formed reference, or `undefined` when every
 * opener is well formed.
 *
 * The grammar's whole promise is that a reference is never mistaken for a literal, and the way that
 * promise breaks is from the other side: `${secret:work_key}` matches nothing, so it stays a literal,
 * gets exported into a child verbatim, and the child authenticates with the eighteen characters of
 * the reference itself. Every failure after that names a remote service and nothing an operator
 * could have looked at. So a configuration boundary that accepts this grammar refuses a near miss
 * with the text of it, and the near miss lives here beside the grammar it is a near miss of.
 *
 * Well-formed references are stripped before the search rather than matched around: one value may
 * carry several, and `Bearer ${secret:GOOD} ${secret:bad}` must report the second rather than be
 * excused by the first.
 */
export function malformedSecretReference(value: string): string | undefined {
  const remainder = value.replace(secretReferencePattern(), '');
  return /\$\{secret:[^}]*\}?/u.exec(remainder)?.[0];
}

/** What a redacted value is replaced with. Naming the secret is deliberate: the NAME is not secret,
 *  and a bare `***` leaves a reader unable to tell which credential the tool was reaching for. */
export function secretMask(name: SecretName): string {
  return `[redacted:${name}]`;
}

/** Longest command a use request may carry, in argv items. */
export const MAX_SECRET_USE_ARGV = 64;

/** Longest single argv item. */
export const MAX_SECRET_USE_ARGUMENT_LENGTH = 8 * 1024;

/** Largest stdout or stderr capture returned, in bytes. Beyond it the stream is truncated and said
 *  to be, because a silently clipped output is evidence a reader will misjudge. */
export const MAX_SECRET_USE_OUTPUT_BYTES = 256 * 1024;

export const SECRET_USE_DEFAULT_TIMEOUT_MS = 60_000;
export const SECRET_USE_MAX_TIMEOUT_MS = 600_000;

/**
 * Run a command with secrets in ITS environment, and in nothing else's.
 *
 * The caller names secrets; it never sends values, and it never receives them. `env` entries may
 * carry `${secret:NAME}` references so a value can be embedded — `Bearer ${secret:TOKEN}` — rather
 * than only exported whole.
 */
export const SecretUseRequestSchema = z
  .object({
    /** argv. `command[0]` is the program; it is executed directly, never through a shell by the
     *  daemon, so nothing here is word-split or expanded on the way. */
    command: z.array(z.string().min(1).max(MAX_SECRET_USE_ARGUMENT_LENGTH)).min(1).max(MAX_SECRET_USE_ARGV).readonly(),
    /** Where to run. Absolute; the daemon refuses a relative one rather than guessing its own cwd. */
    cwd: z.string().min(1),
    /** Secrets exported into the child under their own names. */
    secrets: z.array(SecretNameSchema).max(MAX_SECRETS_PER_DAEMON).readonly().default([]),
    /** Extra environment for the child. Values may contain `${secret:NAME}`. */
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string()).default({}),
    timeoutMs: z.number().int().positive().max(SECRET_USE_MAX_TIMEOUT_MS).default(SECRET_USE_DEFAULT_TIMEOUT_MS),
  })
  .strict();
export type SecretUseRequest = z.input<typeof SecretUseRequestSchema>;
export type SecretUseCommand = z.output<typeof SecretUseRequestSchema>;

/** How a use ended. `timeout` and `spawn_failed` are distinguished from a non-zero exit because an
 *  operator acts differently on each, and a timeout reported as exit 1 is a lie about the program. */
export const SecretUseOutcomeSchema = z.enum(['exited', 'timeout', 'spawn_failed']);
export type SecretUseOutcome = z.infer<typeof SecretUseOutcomeSchema>;

/**
 * What a use produced — AFTER redaction.
 *
 * Every string here has had every known secret value replaced by {@link secretMask}. That is what
 * makes `-- sh -c 'echo $KEY'` return a mask instead of a credential. It does NOT survive an agent
 * transforming the value first; see this file's header.
 */
export const SecretUseResultSchema = z
  .object({
    outcome: SecretUseOutcomeSchema,
    /** Absent when the child never ran or was killed before it could exit. */
    exitCode: z.number().int().optional(),
    stdout: z.string(),
    stderr: z.string(),
    /** True when either stream hit {@link MAX_SECRET_USE_OUTPUT_BYTES} and was cut. */
    truncated: z.boolean(),
    /** Which secrets were injected. Names only — this is the audit trail, and it is not sensitive. */
    used: z.array(SecretNameSchema).readonly(),
  })
  .strict();
export type SecretUseResult = z.infer<typeof SecretUseResultSchema>;
