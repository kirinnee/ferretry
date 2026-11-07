import { defineState } from '@ferretry/kernel/contract';
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
