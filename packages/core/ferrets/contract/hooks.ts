import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import {
  FerretIdSchema,
  FerretRoleSchema,
  FerretStateSchema,
  HarnessKeySchema,
  LoginKindKeySchema,
  RunnerKeySchema,
} from './ids.ts';
import type { Harness, LaunchPartSource, LoginKind, Runner, SitrepLineSource } from './kinds.ts';

/** The hooks Ferrets offers (§3.5 table). Taker lists on the security path are reviewed changes. */

export const Harnesses = defineHook('harnesses', {
  mode: 'provide',
  key: HarnessKeySchema,
  value: z.custom<Harness>(),
  takers: ['claude-code', 'codex'],
});

export const Runners = defineHook('runners', {
  mode: 'provide',
  key: RunnerKeySchema,
  value: z.custom<Runner>(),
  takers: ['terminals'],
});

export const Logins = defineHook('logins', {
  mode: 'provide',
  key: LoginKindKeySchema,
  value: z.custom<LoginKind>(),
  takers: ['logins'],
});

/** Lessons, MCP, Skills, Shells add to every launch. Any plugin may take it. */
export const LaunchParts = defineHook('launch.parts', { mode: 'contribute', item: z.custom<LaunchPartSource>() });

/** What `start.decide` takers are asked: a ferret is about to start. The first no wins, with its reason. */
export const StartDecideInputSchema = z.strictObject({
  ferret: FerretIdSchema,
  name: z.string().min(1),
  role: FerretRoleSchema,
  parent: FerretIdSchema.optional(),
  pack: z.string().optional(),
  harness: HarnessKeySchema,
  runtime: z.string().optional(),
  login: z.string().optional(),
  folder: z.string().min(1),
  /** Who asked for the start. */
  by: z.enum(['owner', 'ferret', 'pack', 'board', 'resume']),
  /** The model the start NAMED (`options.model`); absent when it named none (the harness then picks its own). */
  model: z.string().min(1).optional(),
  /** The start asked for the harness's fast mode (`options.fast`); absent when it did not. */
  fast: z.boolean().optional(),
});
export type StartDecideInput = z.infer<typeof StartDecideInputSchema>;

/**
 * The refusal codes a `start.decide` taker may attach to its `no`: CLOSED, declared here, so a plugin can never mint a
 * code or a status. `unservable_model` is a start that asked for something its model cannot give (fast mode on a model
 * without it); Ferrets answers it `409 unservable_model`. A code outside this list reads as a plain `refused`.
 */
export const StartRefusalCodeSchema = z.enum(['unservable_model']);
export type StartRefusalCode = z.infer<typeof StartRefusalCodeSchema>;

/** Board, Packs, Usage may refuse a start (a budget, a pause, a card rule). Not on the security path. */
export const StartDecide = defineHook('start.decide', { mode: 'decide', input: StartDecideInputSchema });

/**
 * What `auto-resume.decide` takers are asked (W2-a, RULING #27 Q5) before the daemon spends anything bringing back a
 * ferret a host restart took down. Two questions, each the one today's pass asked of the account model:
 *
 * - `switch`: is the machine's "Auto-resume after restart" on (today's `machine.autoResume`)? Asked once per pass,
 *   before any ferret. No yes: the pass resumes nothing and forgets what it was owed, as today's switch off did.
 * - `runtime`: can the runtime this ferret ran on serve a launch right now (today's `resolveStartAccount`)? Asked per
 *   ferret, right before its resume. No yes: that ferret is skipped with the reason, and stays down.
 */
export const AutoResumeDecideInputSchema = z.discriminatedUnion('ask', [
  z.strictObject({ ask: z.literal('switch') }),
  z.strictObject({
    ask: z.literal('runtime'),
    ferret: FerretIdSchema,
    harness: HarnessKeySchema,
    runtime: z.string().min(1),
  }),
]);
export type AutoResumeDecideInput = z.infer<typeof AutoResumeDecideInputSchema>;

/**
 * Runtimes answers whether an automatic resume may spend (W2-a). It FAILS CLOSED, unlike `start.decide`: Ferrets
 * resumes only on Runtimes' OWN yes (`AUTO_RESUME_ANSWERER`); no taker, a failed, hung, throwing or garbage answer, or
 * a yes from any other plugin is a no. The wait is the kernel's decide bound, on the kernel clock.
 */
export const AutoResumeDecide = defineHook('auto-resume.decide', {
  mode: 'decide',
  input: AutoResumeDecideInputSchema,
});

/** Conversation and Board add sitrep lines. */
export const SitrepLines = defineHook('sitrep.lines', { mode: 'contribute', item: z.custom<SitrepLineSource>() });

export const FerretChangedPayloadSchema = z.strictObject({
  ferret: FerretIdSchema,
  state: FerretStateSchema,
  previous: FerretStateSchema.optional(),
  /** What changed besides the state. */
  change: z.enum(['started', 'state', 'stopped', 'renamed', 'moved', 'archived', 'removed']),
});
export type FerretChangedPayload = z.infer<typeof FerretChangedPayloadSchema>;

/** What `ferret.stopping` says: a stop of this ferret is being attempted. */
export const FerretStoppingPayloadSchema = z.strictObject({ ferret: FerretIdSchema });
export type FerretStoppingPayload = z.infer<typeof FerretStoppingPayloadSchema>;

/**
 * A stop of this ferret is being attempted: said BEFORE anything that can fail (a missing harness or runner, a harness
 * stop that throws), so it is heard whether or not the stop then succeeds. Conversation zeroes the ferret's decrypted
 * attachments on it (today's `releasingAttachmentsOnStop`, a `finally` around the stop): a half-stopped ferret holding
 * a decrypted document is the case worth failing closed for. `ferret.changed` still follows a stop that succeeds.
 */
export const FerretStopping = defineHook('ferret.stopping', { mode: 'observe', payload: FerretStoppingPayloadSchema });

/** Updates, Warden, Tidy hear that a ferret changed, after Ferrets' write. */
export const FerretChanged = defineHook('ferret.changed', { mode: 'observe', payload: FerretChangedPayloadSchema });

/**
 * A ferret was started (its record written, its launch under way): who it is, where it runs, who started it and the
 * brief it was given. Additive (lead decision D2 #12), for Board's session-start card path (today's `SessionCards.open`
 * and the `--card` handover). `card` is the existing card the start named (`StartOptions.card`).
 */
export const FerretStartedPayloadSchema = z.strictObject({
  ferret: FerretIdSchema,
  name: z.string().min(1),
  role: FerretRoleSchema,
  parent: FerretIdSchema.optional(),
  pack: z.string().optional(),
  folder: z.string().min(1),
  by: z.enum(['owner', 'ferret', 'pack', 'board']),
  /** The prompt the ferret was started with: its brief. Absent for a start with none (an interactive terminal). */
  brief: z.string().min(1).optional(),
  /** The ownership label given to start (`start --label`). */
  label: z.string().min(1).optional(),
  card: z.string().min(1).optional(),
});
export type FerretStartedPayload = z.infer<typeof FerretStartedPayloadSchema>;

/** Board hears that a ferret started, after Ferrets wrote its record (observe; a taker never fails a start). */
export const FerretStarted = defineHook('ferret.started', { mode: 'observe', payload: FerretStartedPayloadSchema });
