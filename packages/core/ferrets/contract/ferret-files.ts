import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { InstantSchema } from '@ferretry/std';
import { FerretTitleSchema, FerretWaitingSchema } from './ids.ts';
import { StartOptionsSchema } from './port.ts';
import { AgentPinsDocumentSchema, FerretPinsDocumentSchema } from './pins.ts';
import { LAUNCH_SWITCH_VARIABLES } from './instructions-report.ts';
import { SessionConfigSchema, SessionStateSchema } from './view/ferret-view.ts';

/**
 * The per-ferret documents Ferrets keeps under `state/ferrets/` (§9.2), declared in the contract so the daemon that
 * reads them and the converter that writes them share ONE definition (the manifest declares them too, and a manifest
 * imports only contracts). The daemon imports them back.
 *
 * Every body is STRICT: an unknown key is refused (the file reads as damaged), never stripped and never passed through.
 * Every document is `"format": 1` first — the state port stamps and checks it, so the schema describes the body without
 * it. A key a reader needs is declared here; a key nobody declares cannot be written.
 */

/** The longest assigned task a ferret's config carries; the bound keeps the document a document. */
export const MAX_ASSIGNED_TASK_LENGTH = 256 * 1024;

/** The longest name tmux itself accepts as a session address. */
export const MAX_TMUX_SESSION_NAME_LENGTH = 128;

/**
 * `state/ferrets/<ferret>/config.json`: today's session config, every key a relaunch or a reattach reads.
 *
 * The view's keys ({@link SessionConfigSchema}) plus the lifecycle's own. `command` and `tmuxSession` are declared
 * here but optional in the file, as in the view: the lifecycle's record schema is what refuses a config without them
 * when a ferret is relaunched or reattached, so a converter MUST write both for every ferret that can be brought back.
 *   * `command` — the launch argv (its first element is the agent's wrapper executable);
 *   * `prompt` — the assigned task turn one delivers, when there is one;
 *   * `tmuxSession` — the pane's tmux address, which a reattach finds the pane by;
 *   * `capabilityHash` — SHA-256 of the credential the CURRENT pane holds, never the credential; absent for a stopped
 *     or cut-off ferret (today's `sessionCapabilityHash`, renamed).
 */
export const FerretConfigDocumentSchema = z.strictObject({
  ...SessionConfigSchema.shape,
  command: z.array(z.string().min(1)).min(1).optional(),
  prompt: z.string().min(1).max(MAX_ASSIGNED_TASK_LENGTH).optional(),
  tmuxSession: z.string().min(1).max(MAX_TMUX_SESSION_NAME_LENGTH).optional(),
  capabilityHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
});
export type FerretConfigDocument = z.infer<typeof FerretConfigDocumentSchema>;

export const FerretConfigFile = defineState({
  name: 'config',
  path: '*/config.json',
  store: 'json',
  format: 1,
  schema: FerretConfigDocumentSchema,
  mode: 0o600,
});

/** `state/ferrets/<ferret>/state.json`: today's session state (`SessionStateSchema`), strict. */
export const FerretStateDocumentSchema = z.strictObject({ ...SessionStateSchema.shape });
export type FerretStateDocument = z.infer<typeof FerretStateDocumentSchema>;

export const FerretStateFile = defineState({
  name: 'state',
  path: '*/state.json',
  store: 'json',
  format: 1,
  schema: FerretStateDocumentSchema,
  mode: 0o600,
});

/**
 * One ferret's note and message pins (`fy pin`): `state/ferrets/<ferret>/pins.json`. Not the sidebar pin
 * ({@link AgentPinsFile}).
 */
export const FerretPinsFile = defineState({
  name: 'pins',
  path: '*/pins.json',
  store: 'json',
  format: 1,
  schema: FerretPinsDocumentSchema,
  mode: 0o600,
});

/**
 * The owner's pinned ferrets (`fy session pin`, the sidebar's top): `state/ferrets/agent-pins.json`, ferret ids and
 * instants only.
 */
export const AgentPinsFile = defineState({
  name: 'agent-pins',
  path: 'agent-pins.json',
  store: 'json',
  format: 1,
  schema: AgentPinsDocumentSchema,
  mode: 0o600,
});

/**
 * What a ferret was started with beyond its identity, and its task title: `state/ferrets/<ferret>/details.json`.
 * `ferret.json` is frozen (who a ferret is); this file holds today's view fields Ferrets keeps beside it — the start
 * options (`StartOptionsSchema`, the title split out) and the title a start or a rename gave it. A damaged one reads
 * as no options and no title: it is what the summary shows, never what anything is allowed.
 */
export const FerretDetailsSchema = z.strictObject({
  options: StartOptionsSchema.omit({ title: true }).optional(),
  title: FerretTitleSchema.optional(),
});
export type FerretDetails = z.infer<typeof FerretDetailsSchema>;

export const FerretDetailsFile = defineState({
  name: 'details',
  path: '*/details.json',
  store: 'json',
  format: 1,
  schema: FerretDetailsSchema,
  mode: 0o600,
  onDamaged: { narrower: 'a damaged details.json reads as no start options and no title' },
});

/**
 * What a finished ferret handed back with `signal done`: `state/ferrets/<ferret>/summary.md`, beside its `ferret.json`
 * (today's session `summary.md`, written by the signal's `FileSignalArtifacts.writeSummary`). Text as the ferret wrote
 * it, never parsed here: `FerretsApi.summary` hands it to a reader that masks it inside one `Redaction.read`.
 */
export const FerretSummaryFiles = defineState<'summary', Uint8Array>({
  name: 'summary',
  path: '*/summary.md',
  store: 'opaque',
  format: 1,
  mode: 0o600,
});

/**
 * What a ferret's last launch handed its pane of the section switches: `state/ferrets/<ferret>/launch-environment.json`
 * (today's `environment.json`, kept to the switches and never a secret). It is the PERSISTED launch environment that
 * `instructions` reads, through one reader, so a daemon restart changes no answer. Each switch's decision stays with
 * the owner that contributes it as a launch part; this records only what the launch said. Private to Ferrets.
 */
export const FerretLaunchEnvironmentFiles = defineState({
  name: 'launch-environment',
  path: '*/launch-environment.json',
  store: 'json',
  format: 1,
  schema: z.partialRecord(z.enum(LAUNCH_SWITCH_VARIABLES), z.string().max(16)),
  mode: 0o600,
  onDamaged: {
    narrower:
      'a damaged launch-environment.json reads as no recorded switches, so the ferret is told it was not handed them',
  },
});

/**
 * The instruction sections a ferret's last launch was told, by id and fingerprint (never the words):
 * `state/ferrets/<ferret>/launch-sections.json`. It is what `restart --outdated` and the ferret's `outdated` mark
 * compare against the words a launch would give now (today's `launchInstructions` on the session's state document).
 * A ferret with no such file (launched before it was kept, or a damaged one) is never outdated: nothing says what it
 * was told. Private to Ferrets.
 */
export const FerretLaunchSectionsFiles = defineState({
  name: 'launch-sections',
  path: '*/launch-sections.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({
    sections: z.record(z.string().min(1).max(64), z.string().min(1).max(64)),
  }),
  mode: 0o600,
  onDamaged: {
    narrower: 'a damaged launch-sections.json reads as no record, so the ferret is never marked out of date',
  },
});
/**
 * A ferret's declared wait and the time it has been credited for waiting: `state/ferrets/<ferret>/waiting.json` (today's
 * `waiting` and `waitingCreditSeconds` on the session's state document). `ferret.json` is frozen, and a wait moves
 * far more often than who a ferret is. The credit outlives the wait: the turn ceiling must never charge a ferret for
 * time it spent deliberately parked. Private to Ferrets.
 */
export const FerretWaitFiles = defineState({
  name: 'waiting',
  path: '*/waiting.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({
    waiting: FerretWaitingSchema.optional(),
    creditSeconds: z.number().int().nonnegative().optional(),
    /** When the ferret said `signal done` (see `FerretSummary.finishedAt`). */
    finishedAt: InstantSchema.optional(),
  }),
  mode: 0o600,
  onDamaged: { narrower: 'a damaged waiting.json reads as no declared wait and no credit' },
});
