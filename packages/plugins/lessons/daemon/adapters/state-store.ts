import type { KernelPorts } from '@ferretry/kernel/contract';
import {
  DIGESTS_FILE,
  DISMISSED_FILE,
  GLOBAL_FILE,
  type LessonsState,
  type LessonsStateFile,
  OBSERVATIONS_FILE,
  type Observation,
  PATCH_FILE,
  type Proposal,
  RUN_FILE,
  type RunManifest,
  STATE_FILE,
  SUGGESTED_FILE,
  type StoredFerretLessons,
  type Tombstone,
} from '../../contract/index.ts';
import type { SessionDigest } from '../lib/extract.ts';
import { slugify } from '../lib/policy.ts';
import type { LessonsStorePort } from '../lib/store.ts';

/** A run id is a path-safe segment: it names a file. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function runName(runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error('run id must be a path-safe segment');
  return runId;
}

/** The empty state file: nothing mined, nobody instructed. */
const EMPTY: LessonsStateFile = { ferrets: [] };

/** A damaged file is the subsystem's to report (`store_damaged`); this never turns it into an empty board. */
function valueOf<Shape>(read: {
  readonly ok: boolean;
  readonly value?: Shape | undefined;
  readonly error?: { readonly sentence: string };
}): Shape | undefined {
  if (!read.ok) throw new Error(read.error?.sentence ?? 'the lessons files cannot be read');
  return read.value;
}

/** File-authoritative lessons storage over the kernel's state port (`state/lessons/`), with durable JSONL evidence. */
export class StateLessonsStore implements LessonsStorePort {
  constructor(private readonly kernel: Pick<KernelPorts, 'state' | 'clock'>) {}

  private async file(): Promise<LessonsStateFile> {
    return valueOf(await this.kernel.state.read(STATE_FILE)) ?? EMPTY;
  }

  async loadState(): Promise<LessonsState> {
    const { ferrets: _ferrets, passiveDefault: _passive, ...state } = await this.file();
    return state;
  }

  async saveState(state: LessonsState): Promise<void> {
    await this.kernel.state.update(STATE_FILE, current => {
      const { ferrets, passiveDefault } = current ?? EMPTY;
      return { ...state, ferrets, ...(passiveDefault === undefined ? {} : { passiveDefault }) };
    });
  }

  async loadFerretLessons(): Promise<readonly StoredFerretLessons[]> {
    return (await this.file()).ferrets;
  }

  async saveFerretLessons(records: readonly StoredFerretLessons[]): Promise<void> {
    await this.kernel.state.update(STATE_FILE, current => ({ ...(current ?? EMPTY), ferrets: [...records] }));
  }

  async passiveDefault(): Promise<boolean | undefined> {
    return (await this.file()).passiveDefault;
  }

  async setPassiveDefault(value: boolean): Promise<void> {
    await this.kernel.state.update(STATE_FILE, current => ({ ...(current ?? EMPTY), passiveDefault: value }));
  }

  async readObservations(): Promise<readonly Observation[]> {
    const observations: Observation[] = [];
    for await (const line of this.kernel.state.lines(OBSERVATIONS_FILE)) observations.push(line);
    return observations;
  }

  async observationsById(): Promise<ReadonlyMap<string, Observation>> {
    return new Map((await this.readObservations()).map(observation => [observation.id, observation]));
  }

  async appendObservations(observations: readonly Observation[]): Promise<readonly Observation[]> {
    const existing = new Set((await this.readObservations()).map(observation => observation.id));
    const fresh: Observation[] = [];
    for (const observation of observations) {
      if (existing.has(observation.id)) continue;
      existing.add(observation.id);
      fresh.push(observation);
    }
    for (const observation of fresh) await this.kernel.state.append(OBSERVATIONS_FILE, observation);
    return fresh;
  }

  async loadProposals(): Promise<readonly Proposal[]> {
    return valueOf(await this.kernel.state.read(SUGGESTED_FILE))?.proposals ?? [];
  }

  async saveProposals(proposals: readonly Proposal[]): Promise<void> {
    await this.kernel.state.write(SUGGESTED_FILE, { proposals: [...proposals] });
  }

  async loadTombstones(): Promise<readonly Tombstone[]> {
    return valueOf(await this.kernel.state.read(DISMISSED_FILE))?.tombstones ?? [];
  }

  async saveTombstones(tombstones: readonly Tombstone[]): Promise<void> {
    await this.kernel.state.write(DISMISSED_FILE, { tombstones: [...tombstones] });
  }

  async writeRunManifest(manifest: RunManifest): Promise<void> {
    await this.kernel.state.write(RUN_FILE, manifest, runName(manifest.runId));
  }

  async readRunManifest(runId: string): Promise<RunManifest | undefined> {
    return valueOf(await this.kernel.state.read(RUN_FILE, runName(runId)));
  }

  async runIds(): Promise<readonly string[]> {
    return await this.kernel.state.list(RUN_FILE);
  }

  async latestRunManifest(): Promise<RunManifest | undefined> {
    const newest = (await this.kernel.state.list(RUN_FILE)).toSorted().at(-1);
    return newest === undefined ? undefined : await this.readRunManifest(newest);
  }

  async writeDigests(runId: string, digests: readonly SessionDigest[]): Promise<void> {
    await this.kernel.state.write(DIGESTS_FILE, { digests: [...digests] }, runName(runId));
  }

  async readDigests(runId: string): Promise<readonly SessionDigest[] | undefined> {
    return valueOf(await this.kernel.state.read(DIGESTS_FILE, runName(runId)))?.digests;
  }

  async writePatch(id: string, contents: string): Promise<string> {
    const name = `${slugify(id)}-${this.kernel.clock.now().replace(/[:.]/g, '-')}`;
    await this.kernel.state.write(PATCH_FILE, { contents }, name);
    return `patches/${name}.json`;
  }

  async readGlobal(): Promise<string | undefined> {
    return valueOf(await this.kernel.state.read(GLOBAL_FILE))?.text;
  }

  async writeGlobal(text: string): Promise<void> {
    await this.kernel.state.write(GLOBAL_FILE, { text });
  }
}
