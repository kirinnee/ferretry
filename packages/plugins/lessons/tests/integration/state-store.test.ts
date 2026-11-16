/**
 * Lessons' files over the kernel's REAL state port on a real disk (`<home>/state/lessons/`): what is stored survives
 * another store opened on the same folder, a damaged file is reported and never read as an empty board, and a run id
 * that could name a path is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import type { RunManifest } from '../../contract/index.ts';
import { StateLessonsStore } from '../../daemon/adapters/state-store.ts';
import type { SessionDigest } from '../../daemon/lib/extract.ts';
import { AT, observation, proposal } from '../unit/support.ts';
import { diskWorld, type DiskWorld } from './support/lessons-world.ts';

let world: DiskWorld;
beforeEach(async () => {
  world = await diskWorld();
});
afterEach(async () => {
  await world.dispose();
});

const manifest = (runId: string, extra: Partial<RunManifest> = {}): RunManifest => ({
  runId,
  startedAt: AT,
  ferretsScanned: 0,
  ferretsWithSignal: 0,
  minerFerrets: [],
  observationsProposed: 0,
  observationsVerified: 0,
  rejectedQuotes: 0,
  malformedFiles: 0,
  proposalsCreated: 0,
  proposalsStrengthened: 0,
  proposalsSuppressedByTombstone: 0,
  perHarness: { 'claude-code': 0, codex: 0 },
  ...extra,
});

const digest = (ferretId: string): SessionDigest => ({
  ferretId,
  mode: 'auto',
  cwd: '/work/project',
  repo: '/work/project',
  harness: 'claude',
  at: AT,
  hasSignal: true,
  signalReasons: ['correction'],
  corpus: 'Use bun, not Python.',
  digest: 'owner: Use bun, not Python.',
  humanMessages: 1,
  teammateSteers: 0,
  interrupts: 0,
  toolFailures: 0,
});

describe('StateLessonsStore over a real state folder', () => {
  it('reads an empty board before anything is stored', async () => {
    const lessons = world.store;

    expect(await lessons.loadState()).toEqual({});
    expect(await lessons.loadFerretLessons()).toEqual([]);
    expect(await lessons.loadProposals()).toEqual([]);
    expect(await lessons.loadTombstones()).toEqual([]);
    expect(await lessons.readObservations()).toEqual([]);
    expect(await lessons.readGlobal()).toBeUndefined();
    expect(await lessons.runIds()).toEqual([]);
    expect(await lessons.latestRunManifest()).toBeUndefined();
    expect(await lessons.readDigests('run-1')).toBeUndefined();
  });

  it('keeps each ferret’s switch and the board state in one file on disk, each write leaving the other alone', async () => {
    const lessons = world.store;

    await lessons.saveFerretLessons([{ ferretId: 'f1', passive: true, since: AT, setBy: 'owner' }]);
    await lessons.saveState({ ...(await lessons.loadState()), lastRunAt: AT });

    expect((await lessons.loadFerretLessons()).map(entry => entry.ferretId)).toEqual(['f1']);
    expect((await lessons.loadState()).lastRunAt).toBe(AT);
    const onDisk = await readFile(`${world.stateFolder}/state.json`, 'utf8');
    expect(JSON.parse(onDisk)).toMatchObject({ format: 1, lastRunAt: AT, ferrets: [{ ferretId: 'f1' }] });
    expect(onDisk).not.toContain('passiveDefault');

    await lessons.saveState({ lastRunAt: '2026-11-10T00:00:00.000Z' });
    expect((await lessons.loadFerretLessons()).map(entry => entry.ferretId)).toEqual(['f1']);
  });

  it('stores proposals, tombstones and the Global document, read back by another store on the same folder', async () => {
    await world.store.saveProposals([proposal({ id: 'p1' })]);
    await world.store.saveTombstones([{ identity: 'a-rule', titleHash: 'h1', ruleGist: 'a rule', rejectedAt: AT }]);
    await world.store.writeGlobal('# Lessons\n- Use bun.\n');

    const again = new StateLessonsStore(world.kernel);

    expect((await again.loadProposals()).map(entry => entry.id)).toEqual(['p1']);
    expect(await again.loadTombstones()).toHaveLength(1);
    expect(await again.readGlobal()).toBe('# Lessons\n- Use bun.\n');
  });

  it('appends observations to a log without duplicating one it already holds', async () => {
    const lessons = world.store;

    const first = await lessons.appendObservations([observation({ id: 'o1' })]);
    const again = await lessons.appendObservations([
      observation({ id: 'o1' }),
      observation({ id: 'o2' }),
      observation({ id: 'o2' }),
    ]);

    expect(first.map(entry => entry.id)).toEqual(['o1']);
    expect(again.map(entry => entry.id)).toEqual(['o2']);
    expect([...(await lessons.observationsById()).keys()].sort()).toEqual(['o1', 'o2']);
    expect((await readFile(`${world.stateFolder}/observations.jsonl`, 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('keeps a run’s manifest and digests under its own name, and answers the newest run by name', async () => {
    const lessons = world.store;

    await lessons.writeRunManifest(manifest('2026-11-09T10-00-00-000Z'));
    await lessons.writeRunManifest(manifest('2026-11-09T11-00-00-000Z', { message: 'newest' }));
    await lessons.writeDigests('2026-11-09T11-00-00-000Z', [digest('f1')]);

    expect((await lessons.runIds()).toSorted()).toEqual(['2026-11-09T10-00-00-000Z', '2026-11-09T11-00-00-000Z']);
    expect((await lessons.latestRunManifest())?.message).toBe('newest');
    expect((await lessons.readRunManifest('2026-11-09T10-00-00-000Z'))?.runId).toBe('2026-11-09T10-00-00-000Z');
    expect((await lessons.readDigests('2026-11-09T11-00-00-000Z'))?.map(entry => entry.ferretId)).toEqual(['f1']);
    expect(await readdir(`${world.stateFolder}/runs`)).toHaveLength(2);
  });

  it('writes a rendered patch under a name made from the rule’s id and the clock, and says where', async () => {
    const where = await world.store.writePatch('Use Bun / Not Python', '- Use bun.\n');

    expect(where).toBe(`patches/use-bun-not-python-${AT.replace(/[:.]/gu, '-')}.json`);
    expect(JSON.parse(await readFile(`${world.stateFolder}/${where}`, 'utf8'))).toMatchObject({
      contents: '- Use bun.\n',
    });
  });

  it('refuses a run id that is not a path-safe segment, on every run file', async () => {
    const lessons = world.store;

    await expect(lessons.readRunManifest('../escape')).rejects.toThrow('path-safe');
    await expect(lessons.writeRunManifest(manifest('has space'))).rejects.toThrow('path-safe');
    await expect(lessons.writeDigests('.hidden', [])).rejects.toThrow('path-safe');
    await expect(lessons.readDigests('a/b')).rejects.toThrow('path-safe');
  });

  it('says a damaged file is damaged rather than reading it as an empty board', async () => {
    await world.store.saveProposals([proposal({ id: 'p1' })]);
    await writeFile(`${world.stateFolder}/state.json`, '{ not json');
    await writeFile(`${world.stateFolder}/suggested.json`, '{ not json');

    await expect(world.store.loadState()).rejects.toThrow();
    await expect(world.store.loadProposals()).rejects.toThrow();
  });
});
