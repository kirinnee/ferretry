/**
 * The lesson miner over Lessons' REAL files and the kernel's REAL `work` root: its runs, digests and manifests land in the
 * state folder, a miner's answer is a real file in the miner's own folder that the ingest reads and removes, and what
 * the answer says is folded into the board only where its quotes are in what the owner really said. Ferrets is its
 * contract fake and Conversation answers from a table; nothing else is faked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import type { FerretId } from '@ferretry/core-ferrets/contract';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { Instant } from '@ferretry/std';
import { LESSONS_MINER_GAP, type RunManifest } from '../../contract/index.ts';
import { LessonsMiner } from '../../daemon/adapters/miner.ts';
import { LESSONS_MINER_NAME } from '../../daemon/adapters/ferret-sessions.ts';
import { LessonsError } from '../../daemon/lib/index.ts';
import { AT, LESSONS_CONFIG } from '../unit/support.ts';
import { diskWorld, type DiskWorld } from './support/lessons-world.ts';

const T1 = '2026-11-08T10:00:00.000Z' as Instant;
const T2 = '2026-11-08T11:00:00.000Z' as Instant;
const RUN = AT.replace(/[:.]/gu, '-');

interface Said {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly timestamp?: string;
}

let world: DiskWorld;
let transcripts: Map<string, readonly Said[]>;
let sent: Map<string, readonly { message: string; acceptedAt: string; from?: string; fromName?: string }[]>;

beforeEach(async () => {
  world = await diskWorld();
  transcripts = new Map();
  sent = new Map();
});
afterEach(async () => {
  await world.dispose();
});

const conversation = {
  transcript: async (id: string) => {
    const messages = transcripts.get(id);
    return messages === undefined
      ? { ok: false as const, error: { message: 'no transcript' } }
      : { ok: true as const, value: { messages } };
  },
  sends: async (id: string) => ({ sends: sent.get(id) ?? [] }),
};

const minerFolder = (run: string): string => `${world.parent}/work/miner-${run}`;

const minerWith = (
  options: {
    folder?: boolean;
    config?: Partial<typeof LESSONS_CONFIG>;
    ferrets?: ConstructorParameters<typeof LessonsMiner>[0]['ferrets'];
  } = {},
) =>
  new LessonsMiner({
    store: world.store,
    ferrets: options.ferrets ?? world.ferrets,
    conversation: conversation as never,
    roots: world.roots,
    config: () => ({ ...LESSONS_CONFIG, ...options.config }),
    now: () => AT,
    ...(options.folder === false ? {} : { minerFolder }),
  });

/** A stopped ferret the owner spoke to twice: a follow-up is a signal. */
const spoken = async (id: string, stateAt = T1) => {
  const folder = await world.folder('projects', id);
  world.ferret(id, folder, { state: 'stopped', stateAt });
  transcripts.set(id, [
    { role: 'user', text: 'Use bun, not Python, for scripts.', timestamp: T1 },
    { role: 'assistant', text: 'ok' },
    { role: 'user', text: 'Always run task test before you say done.', timestamp: T2 },
  ]);
  return folder;
};

/** The miner ferret's own folder, where its answer is written. */
const answerIn = async (miner: string, run: string, text: string): Promise<string> => {
  const folder = minerFolder(run);
  await mkdir(folder, { recursive: true });
  world.holds(miner, folder);
  const path = `${folder}/.fy-lessons-${run}.json`;
  await writeFile(path, text);
  return path;
};

const GOOD_ANSWER = JSON.stringify({
  observations: [
    { key: 'k1', ferretId: 'f-a', kind: 'correction', gist: 'use bun', quote: 'Use bun, not Python, for scripts.' },
    { key: 'k2', ferretId: 'f-a', kind: 'preference', gist: 'invented', quote: 'a thing nobody said' },
  ],
  proposals: [
    {
      title: 'Use bun for scripts',
      ruleText: 'Use bun, not Python, for scripts.',
      scope: 'global',
      observationKeys: ['k1'],
    },
  ],
});

describe('a spawning run', () => {
  it('refuses with the gap sentence before anything moves when the miner has no folder of its own', async () => {
    await spoken('f-a');

    const run = minerWith({ folder: false }).run(true);

    await expect(run).rejects.toBeInstanceOf(LessonsError);
    await expect(run).rejects.toMatchObject({ reason: 'unavailable', message: LESSONS_MINER_GAP });
    expect(await world.store.loadState()).toEqual({});
    expect(world.ferrets.starts).toEqual([]);
  });

  it('writes a finished manifest saying so when no stopped ferret is new', async () => {
    const manifest = await minerWith().run(true);

    expect(manifest).toMatchObject({ ferretsScanned: 0, message: 'no new stopped ferrets to scan', finishedAt: AT });
    expect((await world.store.readRunManifest(RUN))?.message).toBe('no new stopped ferrets to scan');
  });

  it('reads only stopped ferrets past the watermark, never a miner, oldest first and no more than the run may take', async () => {
    await spoken('f-a', T1);
    await spoken('f-b', T2);
    world.ferret('f-working', await world.folder('projects', 'working'), { state: 'working', stateAt: T1 });
    world.ferret('f-miner', await world.folder('projects', 'miner'), {
      state: 'stopped',
      stateAt: T1,
      name: LESSONS_MINER_NAME,
    });
    transcripts.set('f-working', []);
    transcripts.set('f-miner', []);

    const manifest = await minerWith({ config: { maxFerretsPerRun: 1 } }).run(true);

    expect(manifest.ferretsScanned).toBe(1);
    expect(await world.store.loadState()).toMatchObject({ watermarkId: 'f-a', watermarkAt: T1 });
    const next = await minerWith({ config: { maxFerretsPerRun: 5 } }).run(true);
    expect(next.ferretsScanned).toBe(1);
    expect(await world.store.loadState()).toMatchObject({ watermarkId: 'f-b', watermarkAt: T2 });
  });

  it('says so when every ferret it read had no transcript, and moves the watermark past them', async () => {
    world.ferret('f-gone', await world.folder('projects', 'gone'), { state: 'stopped', stateAt: T1 });

    const manifest = await minerWith().run(true);

    expect(manifest.message).toBe(
      'skipped 1 ferret(s) with missing or unreadable transcripts; no complete conversations to mine',
    );
    expect((await world.store.loadState()).watermarkId).toBe('f-gone');
    expect(world.ferrets.starts).toEqual([]);
  });

  it('says so when no ferret it read had anything to mine', async () => {
    world.ferret('f-quiet', await world.folder('projects', 'quiet'), {
      state: 'stopped',
      stateAt: T1,
      parent: 'f-boss' as FerretId,
    });
    transcripts.set('f-quiet', [{ role: 'user', text: 'one task, no follow-up', timestamp: T1 }]);

    const manifest = await minerWith().run(true);

    expect(manifest.message).toBe('no human signal in the scanned batch');
    expect(manifest.finishedAt).toBe(AT);
  });

  it('starts one miner in its own folder with the digests it will read, and notes what it skipped', async () => {
    await spoken('f-a');
    world.ferret('f-gone', await world.folder('projects', 'gone'), { state: 'stopped', stateAt: T1 });

    const manifest = await minerWith({ config: { model: 'claude-haiku-5-5' } }).run(true);

    expect(manifest).toMatchObject({
      ferretsScanned: 2,
      ferretsWithSignal: 1,
      minerFerrets: ['f1'],
      message: 'skipped 1 ferret(s) with missing or unreadable transcripts',
    });
    const [request] = world.ferrets.starts;
    expect(request).toMatchObject({
      name: LESSONS_MINER_NAME,
      runtime: 'claude',
      role: 'lead',
      folder: minerFolder(RUN),
      by: 'owner',
      options: { model: 'claude-haiku-5-5' },
    });
    expect(request?.prompt).toContain(`${minerFolder(RUN)}/.fy-lessons-${RUN}.json`);
    expect(request?.prompt).toContain('Use bun, not Python, for scripts.');
    expect((await world.store.readDigests(RUN))?.map(digest => digest.ferretId)).toEqual(['f-a']);
    expect(await world.store.readRunManifest(RUN)).toMatchObject({ minerFerrets: ['f1'] });
  });

  it('starts the miner without a model when none is named, and without a skip note when nothing was skipped', async () => {
    await spoken('f-a');

    const manifest = await minerWith().run(true);

    expect(manifest.message).toBeUndefined();
    expect(world.ferrets.starts[0]?.options).toBeUndefined();
  });

  it('reads what the owner and the ferret’s inbox said, as the extractor takes them', async () => {
    const folder = await world.folder('projects', 'helper');
    world.ferret('f-helper', folder, { state: 'stopped', stateAt: T1, parent: 'f-boss' as FerretId, name: 'Builder' });
    transcripts.set('f-helper', [{ role: 'user', text: 'build it' }]);
    sent.set('f-helper', [
      { message: 'Use pnpm, not npm.', acceptedAt: T1 },
      { message: '   ', acceptedAt: T1 },
      { message: 'Mind the lint rules.', acceptedAt: T2, from: 'f-boss', fromName: 'Boss' },
    ]);

    await minerWith().run(true);

    const [digest] = (await world.store.readDigests(RUN)) ?? [];
    expect(digest).toMatchObject({ ferretId: 'f-helper', teammate: 'Builder', mode: 'auto', humanMessages: 1 });
    expect(digest?.digest).toContain('[human] Use pnpm, not npm.');
    expect(digest?.digest).toContain('[steer(Boss)] Mind the lint rules.');
  });

  it('says it could not start the miner, with Ferrets’ reason, when Ferrets refuses', async () => {
    await spoken('f-a');
    const refusing = {
      get: world.ferrets.get.bind(world.ferrets),
      list: world.ferrets.list.bind(world.ferrets),
      stop: world.ferrets.stop.bind(world.ferrets),
      start: async () => ({ ok: false as const, error: { code: 'failed', reason: 'no capacity' } }),
    };

    await expect(minerWith({ ferrets: refusing as never }).run(true)).rejects.toThrow(
      'the lesson miner could not start: no capacity',
    );
  });
});

describe('an ingest-only run', () => {
  it('answers an empty manifest when there is no run yet, and the newest run once there is one', async () => {
    const empty = await minerWith().run(false);

    expect(empty).toMatchObject({ message: 'ingest-only run (no spawn requested)', minerFerrets: [] });

    await spoken('f-a');
    await minerWith().run(true);
    expect((await minerWith().run(false)).runId).toBe(RUN);
  });

  it('folds a finished miner’s answer into the board once, removes the file and keeps only quotes that were said', async () => {
    await spoken('f-a');
    const started = await minerWith().run(true);
    await answerIn(started.minerFerrets[0] as string, RUN, GOOD_ANSWER);

    const finished = await minerWith().run(false);

    expect(finished).toMatchObject({
      finishedAt: AT,
      observationsProposed: 2,
      observationsVerified: 1,
      rejectedQuotes: 1,
      proposalsCreated: 1,
    });
    expect((await world.store.loadProposals()).map(proposal => proposal.title)).toEqual(['Use bun for scripts']);
    expect(await world.store.readObservations()).toHaveLength(1);
    expect(await readdir(minerFolder(RUN))).toEqual([]);
    const again = await minerWith().run(false);
    expect(again.finishedAt).toBe(AT);
    expect(await world.store.readObservations()).toHaveLength(1);
  });

  it('quarantines an answer that is not a miner’s answer, counting it as one malformed file', async () => {
    await spoken('f-a');
    const started = await minerWith().run(true);
    await answerIn(started.minerFerrets[0] as string, RUN, 'this is not json');

    const finished = await minerWith().run(false);

    expect(finished).toMatchObject({
      malformedFiles: 1,
      message: 'miner output was not valid JSON — quarantined',
      finishedAt: AT,
    });
    expect(await world.store.loadProposals()).toEqual([]);
  });

  it('quarantines JSON that is not an object of entries', async () => {
    await spoken('f-a');
    const started = await minerWith().run(true);
    await answerIn(started.minerFerrets[0] as string, RUN, '"just a string"');

    expect((await minerWith().run(false)).malformedFiles).toBe(1);
  });

  it('leaves a run as it was while its miner has written nothing, or is not one this daemon can reach', async () => {
    await spoken('f-a');
    const started = await minerWith().run(true);
    world.holds(started.minerFerrets[0] as string, minerFolder(RUN));

    expect((await minerWith().run(false)).finishedAt).toBeUndefined();

    // A miner whose folder no root reaches cannot be read, and one that has written nothing yet has nothing to read.
    await world.store.writeRunManifest({ ...started, runId: 'orphan', minerFerrets: ['f-unheld'] });
    world.ferrets.add({ id: ferretId('f-unheld'), folder: await world.folder('projects', 'unheld') });
    await world.store.writeDigests('orphan', (await world.store.readDigests(RUN)) ?? []);
    await world.store.writeRunManifest({ ...started, runId: 'quiet', minerFerrets: ['f-a'] });
    await world.store.writeDigests('quiet', []);
    // …and one with no miner ferret at all, or one Ferrets no longer knows.
    await world.store.writeRunManifest({ ...started, runId: 'no-miner', minerFerrets: [] });
    await world.store.writeRunManifest({ ...started, runId: 'ghost', minerFerrets: ['f-ghost'] });
    await world.store.writeDigests('ghost', []);
    await world.store.writeDigests('no-miner', []);

    const runs = await minerWith().run(false);

    expect(runs.finishedAt).toBeUndefined();
    expect((await world.store.readRunManifest('ghost'))?.finishedAt).toBeUndefined();
  });
});

describe('a scan, batch by batch', () => {
  it('reads the size of a ferret’s digest, or nothing for a ferret that has none to give', async () => {
    await spoken('f-a');
    world.ferret('f-mine', await world.folder('projects', 'mine'), { state: 'stopped', name: LESSONS_MINER_NAME });
    world.ferret('f-quiet', await world.folder('projects', 'quiet'), {
      state: 'stopped',
      parent: 'f-boss' as FerretId,
    });
    transcripts.set('f-quiet', [{ role: 'user', text: 'only once', timestamp: T1 }]);
    const miner = minerWith();

    expect(await miner.digestCharacters('f-a')).toBeGreaterThan(20);
    expect(await miner.digestCharacters('nobody')).toBeUndefined();
    expect(await miner.digestCharacters('f-mine')).toBeUndefined();
    expect(await miner.digestCharacters('f-quiet')).toBeUndefined();
    world.ferret('f-unread', await world.folder('projects', 'unread'), { state: 'stopped' });
    expect(await miner.digestCharacters('f-unread')).toBeUndefined();
  });

  it('starts nothing for a batch with nothing to mine, and one miner named for the batch for one that has', async () => {
    await spoken('f-a');
    const miner = minerWith();

    expect(await miner.start('scan-1', 0, ['nobody'], 'claude', undefined)).toBeUndefined();
    expect(world.ferrets.starts).toEqual([]);

    expect(await miner.start('scan-1', 1, ['f-a', 'nobody'], 'codex', 'gpt-model')).toBe('f1');
    expect(world.ferrets.starts[0]).toMatchObject({
      runtime: 'codex',
      folder: minerFolder('scan-1-b1'),
      options: { model: 'gpt-model' },
    });
    expect(await world.store.readRunManifest('scan-1-b1')).toMatchObject({
      runId: 'scan-1-b1',
      ferretsScanned: 2,
      ferretsWithSignal: 1,
      minerFerrets: ['f1'],
    });
  });

  it('reports a batch pending while its miner runs, then its counts once the answer is folded in', async () => {
    await spoken('f-a');
    const miner = minerWith();
    const id = (await miner.start('scan-1', 0, ['f-a'], 'claude', undefined)) as string;

    expect(await miner.collect('scan-1', 0)).toBe('pending');

    world.ferrets.setState(id as FerretId, 'stopped');
    await answerIn(id, 'scan-1-b0', GOOD_ANSWER);
    expect(await miner.collect('scan-1', 0)).toEqual({ added: 1, merged: 0 });
    expect(await miner.collect('scan-1', 0)).toEqual({ added: 1, merged: 0 });
  });

  it('reports a batch failed when its answer was unusable, its miner ended silent, or it was never started', async () => {
    await spoken('f-a');
    const miner = minerWith();
    expect(await miner.collect('scan-9', 0)).toBe('failed');

    const unusable = (await miner.start('scan-2', 0, ['f-a'], 'claude', undefined)) as string;
    await answerIn(unusable, 'scan-2-b0', 'garbage');
    expect(await miner.collect('scan-2', 0)).toBe('failed');

    const silent = (await miner.start('scan-3', 0, ['f-a'], 'claude', undefined)) as string;
    world.holds(silent, minerFolder('scan-3-b0'));
    world.ferrets.setState(silent as FerretId, 'stopped');
    expect(await miner.collect('scan-3', 0)).toBe('failed');
    expect(await world.store.readRunManifest('scan-3-b0')).toMatchObject({
      malformedFiles: 1,
      message: 'the miner ended without writing its output',
    });

    await world.store.writeRunManifest({
      ...((await world.store.readRunManifest('scan-3-b0')) as RunManifest),
      runId: 'scan-4-b0',
      finishedAt: undefined,
      minerFerrets: ['f-ghost'],
    });
    expect(await miner.collect('scan-4', 0)).toBe('failed');
  });

  it('stops a batch’s miner politely', async () => {
    await spoken('f-a');
    const miner = minerWith();
    const id = (await miner.start('scan-1', 0, ['f-a'], 'claude', undefined)) as string;

    await miner.stop(id);

    expect(world.ferrets.stops).toEqual([{ ferret: id as FerretId, how: 'polite' }]);
  });
});

describe('the files a run leaves', () => {
  it('keeps the digests and manifest in Lessons’ own state folder, and the answer in the miner’s folder only', async () => {
    await spoken('f-a');
    await minerWith().run(true);

    expect(await readdir(`${world.stateFolder}/runs`)).toEqual([`${RUN}.json`]);
    expect(await readdir(`${world.stateFolder}/digests`)).toEqual([`${RUN}.json`]);
    expect(JSON.parse(await readFile(`${world.stateFolder}/runs/${RUN}.json`, 'utf8'))).toMatchObject({ runId: RUN });
  });
});
