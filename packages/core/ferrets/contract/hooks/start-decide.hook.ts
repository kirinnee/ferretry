import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { CompactAtSchema } from '../view/compact-at.ts';
import { FerretIdSchema, FerretRoleSchema, HarnessKeySchema } from '../ids.ts';
import { DECIDE_ASK_TIMEOUT_MS } from './decide-timeout.ts';

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
  /**
   * The directory the launch will really be in, every link resolved (the kernel's bound identity); absent when none was
   * bound. `folder` stays the spelling that was asked for: a taker that judges WHERE reads this one.
   */
  realFolder: z.string().min(1).optional(),
  /** Who asked for the start. */
  by: z.enum(['owner', 'ferret', 'pack', 'board', 'warden', 'resume']),
  /** The model the start NAMED (`options.model`); absent when it named none (the harness then picks its own). */
  model: z.string().min(1).optional(),
  /** The start asked for the harness's fast mode (`options.fast`); absent when it did not. */
  fast: z.boolean().optional(),
  /**
   * The compaction trigger the START named (`options.compactAt`); absent when it named none, and ALWAYS absent on a resume
   * (a relaunch falls back to Auto for a value its model cannot honour, as v4 did). A taker that knows the model's window
   * refuses a number larger than it before anything is written, as v4's start did.
   */
  compactAt: CompactAtSchema.optional(),
  /** The start's `options.allowScratch` ({@link StartOptionsSchema}); absent on a resume and on a start that asked no check. */
  allowScratch: z.boolean().optional(),
});
export type StartDecideInput = z.infer<typeof StartDecideInputSchema>;

/**
 * The refusal codes a `start.decide` taker may attach to its `no`: CLOSED, declared here, so a plugin can never mint a
 * code or a status. `unservable_model` is a start that asked for something its model cannot give (fast mode on a model
 * without it); Ferrets answers it `409 unservable_model`. A code outside this list reads as a plain `refused`.
 */
export const StartRefusalCodeSchema = z.enum(['unservable_model']);
export type StartRefusalCode = z.infer<typeof StartRefusalCodeSchema>;

/**
 * Board, Packs, Usage may refuse a start (a budget, a pause, a card rule). Packs' OWN answer is also a helper's
 * admission (ruling #43): Ferrets starts a child only on it. No other taker can pose as Packs, because plugin ids are
 * unique (the graph refuses a duplicate) and the registry is generated at build time.
 */
export const StartDecide = defineHook('start.decide', {
  mode: 'decide',
  input: StartDecideInputSchema,
  // A taker reads a file to answer (Runtimes: the published manifest); the 200 ms default refused healthy starts under load.
  timeoutMs: DECIDE_ASK_TIMEOUT_MS,
});
