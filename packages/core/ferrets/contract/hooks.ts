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

/** Updates, Warden, Tidy hear that a ferret changed, after Ferrets' write. */
export const FerretChanged = defineHook('ferret.changed', { mode: 'observe', payload: FerretChangedPayloadSchema });
