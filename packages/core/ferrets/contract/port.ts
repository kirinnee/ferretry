import { defineEvent, definePort, type FerretId } from '@ferretry/kernel/contract';
import type { Result } from '@ferretry/std';
import { z } from 'zod';
import {
  FerretCardIdSchema,
  type FerretRole,
  type FerretState,
  type FerretSummary,
  FerretTitleSchema,
  FerretStateSchema,
  type HarnessKey,
  type PackId,
} from './ids.ts';
import type { RunnerHandle, SitrepLine } from './kinds.ts';
import type { AgentControl } from './state.ts';

/**
 * The most free-form harness flags one start may carry, and the longest one may be (today's `protocol/src/lib/
 * session.ts`, unchanged).
 *
 * Generous on purpose: a `--settings` overlay is JSON and can run to a few kilobytes. The bounds exist
 * so a body cannot hand the launch argv an unbounded list, never to judge which flags are wise.
 */
export const MAX_HARNESS_FLAGS = 64;
export const MAX_HARNESS_FLAG_LENGTH = 16_384;

/**
 * One caller-supplied harness flag, bounded and free of control characters.
 *
 * A control character has no business in an argv element a human typed: a newline or an escape in
 * one is either a mistake or an attempt to make the recorded command read differently from the one
 * that ran.
 */
export const HarnessFlagSchema = z
  .string()
  .max(MAX_HARNESS_FLAG_LENGTH)
  .refine(value => !/\p{Cc}/u.test(value), 'a harness flag may not contain a control character');

const NonNegativeIntegerSchema = z.number().int().nonnegative();
const PositiveIntegerSchema = z.number().int().positive();

/**
 * How a ferret is started beyond who and where: today's `StartSessionBaseSchema` fields (and `fy new`'s model
 * routing) that are not the ferret's identity. Every field is optional and bounded as today. Ferrets records them in
 * the ferret's `details.json` and shows `model`, `card` and `title` in its summary; the harness, runner and
 * supervision owners read the rest.
 */
export const StartOptionsSchema = z.strictObject({
  /** A task title, free-form (today's `start --name <title>` / `new --name <title>`). */
  title: FerretTitleSchema.optional(),
  /** An ownership label (`start --label`). */
  label: z.string().min(1).optional(),
  /** An EXISTING card the new ferret works on (`start --card`, `new --card`): assigned to it, no second card made. */
  card: FerretCardIdSchema.optional(),
  /** The model, as the runtime lists it (alias or full id). */
  model: z.string().min(1).optional(),
  /**
   * Opaque startup reasoning choice. The selected account's live runtime decision validates the
   * value; the protocol deliberately does not own a second harness effort enum.
   */
  effort: z.string().min(1).optional(),
  /** Launch in the harness's fast mode. Refused when the chosen model has none; omitted leaves it off. */
  fast: z.boolean().optional(),
  /** `auto` for an autonomous teammate (needs a prompt), `interactive` for a human terminal. */
  mode: z.enum(['auto', 'interactive']).optional(),
  /**
   * `fy new --auto`: let Ferretry choose — the models the routing prompt names, in its order, then the ready one with
   * the most headroom. Never together with a named runtime.
   */
  auto: z.boolean().optional(),
  intervalSeconds: PositiveIntegerSchema.optional(),
  timeoutSeconds: NonNegativeIntegerSchema.optional(),
  nudgeAfterSeconds: NonNegativeIntegerSchema.optional(),
  killAfterSeconds: NonNegativeIntegerSchema.optional(),
  directSendMaxChars: NonNegativeIntegerSchema.optional(),
  resumeMenuChoice: z.enum(['full', 'summary']).optional(),
  maxSnapshots: PositiveIntegerSchema.optional(),
  harnessFlags: z.array(HarnessFlagSchema).max(MAX_HARNESS_FLAGS).optional(),
  remoteControl: z.boolean().optional(),
  /** With a name: take a free callsign instead of failing when the name is held. */
  teammateFallback: z.boolean().optional(),
});
export type StartOptions = z.infer<typeof StartOptionsSchema>;

/** A request to start a ferret (from the owner's route, a pack, the board, or a lead for its helper). */
export interface StartRequest {
  readonly name?: string;
  readonly parent?: FerretId;
  readonly pack?: PackId;
  readonly role?: FerretRole;
  readonly harness?: HarnessKey;
  readonly runtime?: string;
  readonly login?: string;
  readonly folder: string;
  readonly prompt?: string;
  /** Start bound to an existing harness conversation (§6.2). */
  readonly harnessConversation?: string;
  readonly by: 'owner' | 'ferret' | 'pack' | 'board';
  /** How to start it beyond who and where ({@link StartOptionsSchema}). */
  readonly options?: StartOptions;
}

export type StartFailure =
  | { readonly code: 'refused'; readonly reason: string } // a start.decide taker said no
  | { readonly code: 'folder'; readonly reason: string } // WorkFolders refused the folder
  | { readonly code: 'harness_unavailable' | 'runner_unavailable' | 'login_unavailable'; readonly reason: string }
  | { readonly code: 'failed'; readonly reason: string };

/** A ferret's whole status: its state, its turn, what plugins add, and its blockers from the Asks port. */
export interface Sitrep {
  readonly ferret: FerretSummary;
  readonly lines: readonly SitrepLine[];
  /** Open asks about this ferret (ids, `!A3`). */
  readonly blockers: readonly string[];
}

/**
 * The Ferrets port (§2.2): who each ferret is, its lineage, its state; start, stop and resume through the harness
 * and runner plugins. "A ferret touches only its own; a lead also its helpers'" is `mayTouch`, decided here and
 * nowhere else.
 */
export interface FerretsApi {
  get(ferret: FerretId): Promise<FerretSummary | undefined>;
  list(filter?: {
    readonly state?: FerretState;
    readonly parent?: FerretId;
    readonly pack?: PackId;
  }): Promise<readonly FerretSummary[]>;
  /** Synchronous, memory-only: whether `caller` may act on `target` (itself, or a helper of its own lineage). */
  mayTouch(caller: FerretId, target: FerretId): boolean;
  children(ferret: FerretId): readonly FerretId[];
  /** The harness keys currently provided under `harnesses` (a plugin off is absent). */
  harnesses(): readonly HarnessKey[];
  start(request: StartRequest): Promise<Result<FerretId, StartFailure>>;
  /** Stops a ferret; `reason` is recorded in its history (today's default: "stopped by client"). */
  stop(ferret: FerretId, how: 'polite' | 'now', reason?: string): Promise<void>;
  /**
   * Revives a stopped ferret with its conversation. `message` is recorded in its history; delivering it into the
   * conversation is the Conversation's.
   */
  resume(ferret: FerretId, message?: string): Promise<Result<FerretId, StartFailure>>;
  /** Adopts a live process by its runner handle without restarting it (spine D15). */
  attach(ferret: FerretId, handle: RunnerHandle): Promise<Result<FerretId, StartFailure>>;
  /**
   * The runner handle of a running ferret (Terminals: its tmux pane id), as `ferret.json` keeps it, so a harness finds
   * the ferret's pane after a daemon restart. `undefined` for a stopped or unknown ferret. Not a secret.
   */
  handle(ferret: FerretId): Promise<RunnerHandle | undefined>;
  /**
   * The folder a ferret was started in (its work folder), for Accounts' sign-in ordering, as its REAL path resolved
   * through Ferrets' fenced `work` root. The recorded folder must still be its own real path (today's
   * `sign-in-context.ts` `folderOf`): a folder swapped for a symlink elsewhere, a failed resolve or an unknown ferret
   * answers `undefined`. Accounts compares the folder under the owner's home (kernel `paths.home()`). The PROJECT is
   * not Ferrets': today it came from the Board (`projectOf(session)`), and core cannot import Board or Projects, so
   * Accounts gets it from the Board.
   */
  workFolder(ferret: FerretId): Promise<{ readonly folder: string } | undefined>;
  sitrep(ferret: FerretId): Promise<Sitrep | undefined>;
  /**
   * What this ferret may control right now (today's "What agents may control"): `limits.yaml`'s `agentControl` over
   * today's defaults, read fresh on every call so a change applies to the ferret's very next action. A ferret this
   * daemon does not know may control nothing.
   */
  agentControl(ferret: FerretId): Promise<AgentControl>;
}

export const FerretsPort = definePort<FerretsApi>('ferrets');

/**
 * A ferret was added, changed state, or went away. A wake-up for views; the truth is `FerretsPort`.
 * State and absence also let Vault end its input values without a needs cycle back to Ferrets (I108).
 * Missing state says nothing about whether the ferret ended: readers keep masking until they know.
 */
export const FerretsChanged = defineEvent(
  'ferrets.changed',
  z.strictObject({
    ferret: z.string().min(1),
    generation: z.number().int(),
    state: FerretStateSchema.optional(),
    gone: z.literal(true).optional(),
  }),
);
