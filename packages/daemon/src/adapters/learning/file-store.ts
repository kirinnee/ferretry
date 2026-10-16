import { join } from 'node:path';
import { RunManifestSchema } from '@ferretry/protocol';
import type { z } from 'zod';
import type {
  ClockPort,
  FileSystemPort,
  FoundationPaths,
  LearningState,
  LearningStorePort,
  StoredSessionLearning,
  Observation,
  Proposal,
  RunManifest,
  Tombstone,
} from '../../lib/index.ts';
import { parseJsonl, slugify } from '../../lib/learning/policy.ts';
import {
  LearningStateSchema,
  ObservationSchema,
  StoredProposalSchema,
  StoredSessionLearningSchema,
  TombstoneSchema,
} from '../../lib/learning/types.ts';

interface LearningPaths {
  readonly directory: string;
  readonly state: string;
  readonly observations: string;
  readonly proposals: string;
  readonly tombstones: string;
  readonly runs: string;
  readonly patches: string;
  readonly sessions: string;
}

function createLearningPaths(paths: FoundationPaths): LearningPaths {
  const directory = join(paths.state, 'learning');
  return {
    directory,
    state: join(directory, 'state.json'),
    observations: join(directory, 'observations.jsonl'),
    proposals: join(directory, 'proposals.json'),
    tombstones: join(directory, 'tombstones.json'),
    runs: join(directory, 'runs'),
    patches: join(directory, 'patches'),
    sessions: join(directory, 'sessions.json'),
  };
}

function runPath(paths: LearningPaths, runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error('run id must be a path-safe segment');
  return join(paths.runs, runId);
}

function decodeJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function decodeOr<T>(text: string | undefined, schema: z.ZodType<T>, fallback: T): T {
  const parsed = schema.safeParse(decodeJson(text));
  return parsed.success ? parsed.data : fallback;
}

/** One malformed record costs that record alone, never the rest of the file. */
function decodeEach<T>(text: string | undefined, schema: z.ZodType<T, unknown>): readonly T[] {
  const value = decodeJson(text);
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const parsed = schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** File-authoritative learning storage with durable JSONL evidence appends. */
export class FileLearningStore implements LearningStorePort {
  private readonly paths: LearningPaths;

  constructor(
    foundation: FoundationPaths,
    private readonly files: FileSystemPort,
    private readonly clock: ClockPort,
  ) {
    this.paths = createLearningPaths(foundation);
  }

  async ensureDirectories(): Promise<void> {
    await Promise.all([
      this.files.ensureDirectory(this.paths.directory, 0o700),
      this.files.ensureDirectory(this.paths.runs, 0o700),
      this.files.ensureDirectory(this.paths.patches, 0o700),
    ]);
  }

  async loadState(): Promise<LearningState> {
    return decodeOr(await this.files.readText(this.paths.state), LearningStateSchema, {});
  }

  async saveState(state: LearningState): Promise<void> {
    await this.files.writeTextAtomic(this.paths.state, `${JSON.stringify(state, null, 2)}\n`);
  }

  async readObservations(): Promise<readonly Observation[]> {
    return parseJsonl((await this.files.readText(this.paths.observations)) ?? '', ObservationSchema);
  }

  async observationsById(): Promise<ReadonlyMap<string, Observation>> {
    return new Map((await this.readObservations()).map(observation => [observation.id, observation]));
  }

  async appendObservations(observations: readonly Observation[]): Promise<readonly Observation[]> {
    await this.ensureDirectories();
    const existing = new Set((await this.readObservations()).map(observation => observation.id));
    const fresh: Observation[] = [];
    for (const observation of observations) {
      if (existing.has(observation.id)) continue;
      existing.add(observation.id);
      fresh.push(observation);
    }
    for (const observation of fresh)
      await this.files.appendLineDurable(this.paths.observations, JSON.stringify(observation));
    return fresh;
  }

  async loadProposals(): Promise<readonly Proposal[]> {
    return decodeEach(await this.files.readText(this.paths.proposals), StoredProposalSchema);
  }

  async saveProposals(proposals: readonly Proposal[]): Promise<void> {
    await this.files.writeTextAtomic(this.paths.proposals, `${JSON.stringify(proposals, null, 2)}\n`);
  }

  async loadTombstones(): Promise<readonly Tombstone[]> {
    return decodeEach(await this.files.readText(this.paths.tombstones), TombstoneSchema);
  }

  async saveTombstones(tombstones: readonly Tombstone[]): Promise<void> {
    await this.files.writeTextAtomic(this.paths.tombstones, `${JSON.stringify(tombstones, null, 2)}\n`);
  }

  async writeRunManifest(manifest: RunManifest): Promise<void> {
    const directory = runPath(this.paths, manifest.runId);
    await this.files.ensureDirectory(directory, 0o700);
    await this.files.writeTextAtomic(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  async readRunManifest(runId: string): Promise<RunManifest | undefined> {
    const text = await this.files.readText(join(runPath(this.paths, runId), 'manifest.json'));
    return decodeOr(text, RunManifestSchema.optional(), undefined);
  }

  async latestRunManifest(): Promise<RunManifest | undefined> {
    const directories = await this.files.listDirectory(this.paths.runs);
    const newest = directories
      .filter(entry => entry.directory)
      .map(entry => entry.name)
      .toSorted()
      .at(-1);
    return newest === undefined ? undefined : await this.readRunManifest(newest);
  }

  async loadSessionLearning(): Promise<readonly StoredSessionLearning[]> {
    return decodeEach(await this.files.readText(this.paths.sessions), StoredSessionLearningSchema);
  }

  async saveSessionLearning(records: readonly StoredSessionLearning[]): Promise<void> {
    await this.ensureDirectories();
    await this.files.writeTextAtomic(this.paths.sessions, `${JSON.stringify(records, null, 2)}\n`);
  }

  async writePatch(id: string, contents: string): Promise<string> {
    await this.files.ensureDirectory(this.paths.patches, 0o700);
    const timestamp = this.clock.now().replace(/[:.]/g, '-');
    const file = join(this.paths.patches, `${slugify(id)}-${timestamp}.md`);
    await this.files.writeTextAtomic(file, contents);
    return file;
  }
}
