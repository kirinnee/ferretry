import type { ClockPort } from '../ports.ts';
import type {
  LearningState,
  Observation,
  Proposal,
  RunManifest,
  StoredSessionLearning,
  Tombstone,
} from './types.ts';

/** Persistence boundary for the learning subsystem. Implemented only by adapters. */
export interface LearningStorePort {
  ensureDirectories(): Promise<void>;
  loadState(): Promise<LearningState>;
  saveState(state: LearningState): Promise<void>;
  readObservations(): Promise<readonly Observation[]>;
  observationsById(): Promise<ReadonlyMap<string, Observation>>;
  appendObservations(observations: readonly Observation[]): Promise<readonly Observation[]>;
  loadProposals(): Promise<readonly Proposal[]>;
  saveProposals(proposals: readonly Proposal[]): Promise<void>;
  loadTombstones(): Promise<readonly Tombstone[]>;
  saveTombstones(tombstones: readonly Tombstone[]): Promise<void>;
  writeRunManifest(manifest: RunManifest): Promise<void>;
  readRunManifest(runId: string): Promise<RunManifest | undefined>;
  latestRunManifest(): Promise<RunManifest | undefined>;
  writePatch(id: string, contents: string): Promise<string>;
  /** Which ferrets are instructed to learn, one record per session. */
  loadSessionLearning(): Promise<readonly StoredSessionLearning[]>;
  saveSessionLearning(records: readonly StoredSessionLearning[]): Promise<void>;
}

export interface LearningStoreDependencies {
  readonly clock: ClockPort;
}
