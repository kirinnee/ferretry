/**
 * The session records a runtime removal or rename reads and re-points, over the Ferrets port
 * (docs/account-model.md "Renaming a runtime").
 *
 * Ferrets owns the records: it reads them and does the locked rewrite of their runtime name. This is a thin
 * translation of its answers into what the catalog service asks, and reads no file of Ferrets' state.
 * Reading is tolerant — a Ferrets that cannot answer leaves the confirm card saying only what it knows — and so is
 * re-pointing: a rename never fails for a record left on the old name, which still resolves through `ids.json`.
 */
import type { FerretRuntimeRecord, FerretsApi, FerretState } from '@ferretry/core-ferrets/contract';
import type { SessionStatus } from '../lib/service/foreign.ts';
import type { RuntimeSessionRecord, SessionRuntimeRename } from '../lib/service/runtime-sessions.ts';

/** What this needs of Ferrets: the two additive members a runtime change reads and writes through. */
export type RuntimeSessionFerrets = Required<Pick<FerretsApi, 'runtimeRecords' | 'repointRuntime'>>;

/** A ferret's state as the catalog counts a session: the ones still going are the ones a removal would strand. */
export const SESSION_STATUS_OF: Readonly<Record<FerretState, SessionStatus>> = {
  starting: 'starting',
  working: 'running',
  idle: 'waiting',
  stopped: 'stopped',
};

const recordOf = (record: FerretRuntimeRecord): RuntimeSessionRecord => ({
  id: record.id,
  name: record.name,
  harness: record.harness,
  agent: record.agent,
  ...(record.executable === undefined ? {} : { executable: record.executable }),
  status: SESSION_STATUS_OF[record.state],
});

export class RuntimeSessionRecords {
  constructor(private readonly ferrets: RuntimeSessionFerrets) {}

  /** Every ferret Ferrets keeps that names a runtime, ended ones included. */
  async sessionRecords(): Promise<readonly RuntimeSessionRecord[]> {
    return (await this.ferrets.runtimeRecords()).map(recordOf);
  }

  /** Re-point every record on the old runtime at the new one. Answers how many moved. */
  async renameSessions(rename: SessionRuntimeRename): Promise<number> {
    return await this.ferrets.repointRuntime(rename);
  }
}
