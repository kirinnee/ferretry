import type { LessonsState, Observation, Proposal, RunManifest, StoredFerretLessons, Tombstone } from './types.ts';
import type { SessionDigest } from './extract.ts';

/** Persistence boundary for the lessons subsystem. Implemented only by adapters. */
export interface LessonsStorePort {
  loadState(): Promise<LessonsState>;
  saveState(state: LessonsState): Promise<void>;
  readObservations(): Promise<readonly Observation[]>;
  observationsById(): Promise<ReadonlyMap<string, Observation>>;
  appendObservations(observations: readonly Observation[]): Promise<readonly Observation[]>;
  loadProposals(): Promise<readonly Proposal[]>;
  saveProposals(proposals: readonly Proposal[]): Promise<void>;
  loadTombstones(): Promise<readonly Tombstone[]>;
  saveTombstones(tombstones: readonly Tombstone[]): Promise<void>;
  writeRunManifest(manifest: RunManifest): Promise<void>;
  readRunManifest(runId: string): Promise<RunManifest | undefined>;
  runIds(): Promise<readonly string[]>;
  latestRunManifest(): Promise<RunManifest | undefined>;
  writeDigests(runId: string, digests: readonly SessionDigest[]): Promise<void>;
  readDigests(runId: string): Promise<readonly SessionDigest[] | undefined>;
  writePatch(id: string, contents: string): Promise<string>;
  /** Which ferrets are instructed to learn, one record per ferret. */
  loadFerretLessons(): Promise<readonly StoredFerretLessons[]>;
  saveFerretLessons(records: readonly StoredFerretLessons[]): Promise<void>;
  /** The Global lessons document, `undefined` until the first Apply. */
  readGlobal(): Promise<string | undefined>;
  writeGlobal(text: string): Promise<void>;
}
