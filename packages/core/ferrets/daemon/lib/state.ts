import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { FerretTitleSchema, StartOptionsSchema } from '../../contract/index.ts';
import { AgentPinFileSchema } from './agent-pins/types.ts';
import { PinSchema } from './protocol/pins.ts';
import { SessionConfigSchema, SessionStateSchema } from './protocol/session.ts';

/**
 * The session documents Ferrets keeps under `state/ferrets/<session>/` (§9.2). Private to Ferrets: no other piece
 * reads them, so they are declared here and listed in the manifest's `data.state`, never in the contract.
 *
 * Every document has `"format": 1` first. The schema is today's `SessionConfig` / `SessionState`, kept LOOSE on
 * purpose: `SessionStateSchema` is the PUBLIC state ("internal queue payloads and filesystem proofs are omitted"),
 * and the stored document carries those keys too, so a schema that stripped or refused unknown keys would lose them
 * on the next read-modify-write.
 */
export const SessionConfigFiles = defineState({
  name: 'session-config',
  path: '*/config.json',
  store: 'json',
  format: 1,
  schema: SessionConfigSchema.loose(),
  mode: 0o600,
});

export const SessionStateFiles = defineState({
  name: 'session-state',
  path: '*/state.json',
  store: 'json',
  format: 1,
  schema: SessionStateSchema.loose(),
  mode: 0o600,
});

/**
 * The owner's pinned ferrets (`fy session pin`, the sidebar's top): `state/ferrets/agent-pins.json`, ferret ids and
 * instants only. Private to Ferrets.
 */
export const AgentPinsFile = defineState({
  name: 'agent-pins',
  path: 'agent-pins.json',
  store: 'json',
  format: 1,
  schema: AgentPinFileSchema,
  mode: 0o600,
});

/**
 * One ferret's note and message pins (`fy pin`): `state/ferrets/<ferret>/pins.json`. Not the sidebar pin above.
 * Private to Ferrets.
 */
export const FerretPinFiles = defineState({
  name: 'pins',
  path: '*/pins.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ pins: z.array(PinSchema) }),
  mode: 0o600,
});

/**
 * What a ferret was started with beyond its identity, and its task title: `state/ferrets/<ferret>/details.json`.
 * `ferret.json` is frozen (who a ferret is); this file holds today's view fields Ferrets keeps beside it — the start
 * options (`StartOptionsSchema`, the title split out) and the title a start or a rename gave it. Private to Ferrets.
 * A damaged one reads as no options and no title: it is what the summary shows, never what anything is allowed.
 */
export const FerretDetailsSchema = z.strictObject({
  options: StartOptionsSchema.omit({ title: true }).optional(),
  title: FerretTitleSchema.optional(),
});
export type FerretDetails = z.infer<typeof FerretDetailsSchema>;

export const FerretDetailsFiles = defineState({
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
