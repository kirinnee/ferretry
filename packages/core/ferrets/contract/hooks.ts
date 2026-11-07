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
});
export type StartDecideInput = z.infer<typeof StartDecideInputSchema>;

/** Board, Packs, Usage may refuse a start (a budget, a pause, a card rule). Not on the security path. */
export const StartDecide = defineHook('start.decide', { mode: 'decide', input: StartDecideInputSchema });

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
