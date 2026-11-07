/**
 * WHAT ACCOUNTS NEEDS OF THE VAULT'S INPUT REQUESTS, copied byte for byte from today's
 * `packages/daemon/src/lib/input-requests/{login-observer,lock,saved-logins,ports}.ts` (bb89d054d).
 *
 * TODO(contract): every name here belongs to the Vault (input requests). The shared grant matcher (I210) must run the
 * SAME `codeTargetProblem`, `identityOf` and `terminalHides` the Vault's tap path runs, so these copies are a stopgap
 * until the Vault's contract exports them (or offers an `input.grants` hook that Accounts provides). The two ports at
 * the bottom are what the Vault's input-request service asks of a secure copy and a paste rule; nothing in the
 * Vault's contract takes them yet.
 */
import { createHash } from 'node:crypto';
import type { InputSensitivity, InputTargetFacts } from '@ferretry/core-vault/contract';
import { z } from 'zod';
import {
  type AccountList,
  CopyPlanIdSchema,
  type CopyMeta,
  type CopyName,
  type CopyOrigin,
  type InputFieldElement,
  SignInRuleIdSchema,
  SignInRuleRevisionSchema,
  TaskPlanLineNumberSchema,
} from '../../contract/routes/index.ts';

/** How long the daemon watches a page for the second factor after a submit (`login-observer.ts`). */
export const SECOND_FACTOR_WINDOW_MS = 180_000;

const digest = (parts: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

/**
 * The field's identity: what would have to change for these facts to be about another field. A page: its origin and,
 * per field, the frame's origin, the tag and the attributes that say what it is. A terminal: the place and the program.
 */
export function identityOf(facts: InputTargetFacts, place: string): string | undefined {
  if (facts.kind === 'page')
    return digest([
      'page',
      facts.origin,
      ...facts.fields.map(field => [
        field.frameOrigin,
        field.field.tag,
        field.field.type ?? '',
        field.field.name ?? '',
        field.field.id ?? '',
        field.field.autocomplete ?? '',
      ]),
    ]);
  if (facts.kind === 'terminal') return digest(['terminal', place, facts.foreground.comm]);
  return undefined;
}

/**
 * The programs whose prompt is a local password read (getpass): echo off in line mode, nothing drawn. A relay (ssh,
 * docker, kubectl) or a readline program (psql, mysql) turns echo off and draws what is typed, so it is never one.
 */
export const GETPASS_PROGRAMS: ReadonlySet<string> = new Set(['sudo', 'sudoedit', 'su', 'doas', 'passwd']);

/**
 * The programs whose echo-off prompt may be a one-time code: remote shells and cloud CLIs that ask for a 2FA code. A
 * bare shell's `read -s` is never one, whatever its line says. Matched against the REAL executable a process runs, and
 * only one this account cannot replace (`CodeProgramPort`): a name in `ps` can be rewritten or copied.
 */
export const CODE_PROGRAMS: ReadonlySet<string> = new Set([
  'ssh',
  'scp',
  'sftp',
  'mosh-client',
  'aws',
  'gcloud',
  'az',
  'vault',
]);

/**
 * Whether a terminal hides what is typed so well that the short lock is enough: echo off, line mode, the line was
 * placed. EVERY process of the foreground group runs setuid root and the kernel names the group's program a getpass one
 * (`program`, never `foreground.comm`, which a shell can rewrite to `sudo`). Anything less keeps the full lock.
 */
export function terminalHides(facts: InputTargetFacts): boolean {
  return (
    facts.kind === 'terminal' &&
    facts.echo === 'off' &&
    facts.canonical === true &&
    facts.trustedProgram === true &&
    facts.program !== undefined &&
    GETPASS_PROGRAMS.has(facts.program)
  );
}

/** What a card's offers are drawn from: the accounts and sign-ins, never a value (`saved-logins.ts`). */
export type SavedListing = Pick<AccountList, 'accounts' | 'signIns'>;

/**
 * WHY THE DAEMON MAY NOT TYPE A ONE-TIME CODE IT MADE into these fields of what it saw, or `undefined` when it may. A
 * code it makes is a second factor typed by the machine itself, so where it lands is not the owner's call on a flag:
 *
 * - never into the secret store, and never before the daemon has looked at the target again;
 * - a page: only on https, into a field the browser reported visible and uncovered, in the page's own frame (a frame
 *   from another origin could be anyone's), so the code goes exactly where the matched sign-in signs in;
 * - a terminal: the card's one prompt, whose key (`tool@host` of a PROVED program in line mode) the sign-in matched.
 *
 * Fixed sentences only: they reach the owner and the log.
 */
export function codeTargetProblem(
  facts: InputTargetFacts | undefined,
  fieldIds: readonly string[],
): string | undefined {
  if (facts === undefined) return 'Ferretry is looking at the target again';
  if (facts.kind === 'secret') return 'a code Ferretry makes is typed only into a sign-in';
  if (facts.kind === 'terminal') return undefined;
  if (!facts.secure) return 'the page is not https';
  for (const id of fieldIds) {
    const found = facts.fields.find(field => field.fieldId === id);
    if (found === undefined || !found.visible) return 'Ferretry cannot see the code field on the page';
    if (found.covered === true) return 'something on the page covers the code field';
    if (found.frameOrigin !== facts.origin) return 'the code field is inside a frame from another site';
  }
  return undefined;
}

/**
 * WHO DELIVERED A VALUE (`protocol/src/lib/input-request.ts`): the machine, a paired device's tap, a paste rule, a
 * task-plan line or a standing sign-in rule.
 */
export const InputActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host') }),
  z.strictObject({
    kind: z.literal('device'),
    deviceId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'must be one line with no control characters'),
  }),
  /** A paste the owner approved IN ADVANCE: the daemon delivered it under this pre-approval rule (docs/secure-copy.md). */
  z.strictObject({ kind: z.literal('rule'), ruleId: z.string().regex(/^[0-9a-f]{32}$/u) }),
  /** A sign-in the owner approved IN ADVANCE on a task plan: the daemon filled it under this plan line (task-plan.ts). */
  z.strictObject({ kind: z.literal('plan'), planId: CopyPlanIdSchema, line: TaskPlanLineNumberSchema }),
  /**
   * A sign-in the owner approved IN ADVANCE with a standing rule: the daemon filled it under this rule, at this revision
   * (sign-in-rules.ts). Not `rule`: that is a paste rule, with its own 32-hex id.
   */
  z.strictObject({ kind: z.literal('sign-in-rule'), rule: SignInRuleIdSchema, revision: SignInRuleRevisionSchema }),
]);
export type InputActor = z.infer<typeof InputActorSchema>;

/** One value on an input card, as the grant matcher reads it (`InputRequestField`). */
export interface InputRequestField {
  readonly id: string;
  readonly label: string;
  readonly sensitivity: InputSensitivity;
  readonly element?: InputFieldElement | undefined;
  readonly risk?: { readonly level: 'green' | 'neutral' | 'amber' | 'red'; readonly reason: string } | undefined;
}

/** A browser element a secure copy reads from (`protocol/src/lib/browser-target.ts`). */
export type BrowserElementTarget =
  | { readonly kind: 'selector'; readonly selector: string }
  | { readonly kind: 'ref'; readonly ref: string };

/**
 * Secure copies (docs/secure-copy.md), as a paste needs them. `open` is the second place a value leaves this port set,
 * beside the target adapter's `type`: it is called once per write, after every check that can refuse without typing,
 * and its answer goes only to `type`.
 */
export interface InputSealedPort {
  /** What the daemon recorded about a live copy of this session, or nothing: never the value. */
  describe(sessionId: string, name: CopyName): CopyMeta | undefined;
  /** The live copy's value for the one write; nothing once it was discarded or expired. */
  open(sessionId: string, name: CopyName): string | undefined;
  /** A paste of it was typed. */
  used(sessionId: string, name: CopyName): void;
}

/**
 * The owner's pre-approval rules, as a paste asks them: the rule that allows this paste is RESERVED (its count taken)
 * synchronously, so two pastes can never both spend a rule's last use. Matched on what the daemon saw.
 */
export interface InputPasteRules {
  /** `profile`: the name of a program proved only through the owner's profile (`ObserveResult.profileProgram`). */
  reserve(sessionId: string, from: CopyOrigin, facts: InputTargetFacts, profile?: string): string | undefined;
  /** The paste a rule was reserved for was not typed: its use is given back. */
  release(ruleId: string): void;
  /** It was typed. */
  spent(ruleId: string): void;
}
