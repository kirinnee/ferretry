/**
 * The Lessons-owned F rows of docs/design/rebuild-parity.tsv, one test per row (or row group), each named by its ids.
 * Today's `FY_HOME/state/learning/…` is the kernel's `state/lessons/…` (the plugin id is the folder); every file is a
 * declared state file at format 1, written by the real adapter. Renames are named in each test.
 */
import { describe, expect, test } from 'bun:test';
import { ferretId } from '@ferretry/core-ferrets/contract/testing';
import { MemoryStateFolder, ferret, owner } from '@ferretry/kernel/testing';
import {
  DIGESTS_FILE,
  DISMISSED_FILE,
  GLOBAL_FILE,
  LESSONS_CONFIG,
  LESSONS_STATE,
  OBSERVATIONS_FILE,
  PATCH_FILE,
  RUN_FILE,
  STATE_FILE,
  SUGGESTED_FILE,
} from '../../../contract/index.ts';
import { StateLessonsStore } from '../../../daemon/adapters/state-store.ts';
import { LessonsMiner } from '../../../daemon/adapters/miner.ts';
import manifest from '../../../manifest.ts';
import { AT, LESSONS_CONFIG as CONFIG, FakeLessonsStore } from '../support.ts';
import { lessonsHost } from './host.ts';

const store = (folder = new MemoryStateFolder(), now = AT) =>
  new StateLessonsStore({ state: folder.port(LESSONS_STATE), clock: { now: () => now } } as never);

const manifestOf = (runId: string) => ({
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
});

/** A ferret files a lesson and the owner accepts it, through the real routes on the test host. */
async function filedAndAccepted() {
  const world = await lessonsHost();
  world.ferrets.add({ id: ferretId('f1'), name: 'hadi', folder: '/work/repo', mode: 'interactive' });
  const filed = await world.host.tool(
    'lessons_suggest',
    { rule: 'Use bun, not Python, for scripts.', scope: 'global' },
    { as: ferret('f1') },
  );
  expect(filed.isError).not.toBe(true);
  const [proposal] = JSON.parse(
    (await world.host.request('GET', '/v1/lessons/proposals', { as: owner() })).body as string,
  ) as { id: string }[];
  const accepted = await world.host.request('POST', `/v1/lessons/proposals/${proposal?.id}`, {
    as: owner(),
    body: { action: 'accept' },
  });
  expect(accepted.status).toBe(200);
  return { ...world, folder: world.host.state('lessons') };
}

describe('the lessons state folder', () => {
  test('F-0259 state/learning is state/lessons: every file is declared by the lessons plugin, at format 1', () => {
    expect(manifest.id).toBe('lessons');
    expect(manifest.data.state.map(file => file.path)).toEqual([
      'state.json',
      'observations.jsonl',
      'suggested.json',
      'dismissed.json',
      'runs/*.json',
      'digests/*.json',
      'patches/*.json',
      'global.json',
    ]);
    expect(manifest.data.state.every(file => file.format === 1)).toBe(true);
  });

  test('F-0165 F-0371 config/learning.yaml is config/lessons.yaml, read live by GET /v1/lessons/config', async () => {
    expect(LESSONS_CONFIG.file).toBe('lessons.yaml');
    const { host } = await lessonsHost({ config: { 'lessons.yaml': { passiveDefault: false, batchSize: 5 } } });
    const config = JSON.parse((await host.request('GET', '/v1/lessons/config', { as: owner() })).body as string);
    expect(config).toMatchObject({ passiveDefault: false, batchSize: 5 });
  });

  test('F-0260 F-0388 observations.jsonl: a filed lesson appends its evidence, once', async () => {
    const { folder } = await filedAndAccepted();
    expect(OBSERVATIONS_FILE.path).toBe('observations.jsonl');
    expect(OBSERVATIONS_FILE.store).toBe('jsonl');
    const lines = (folder.raw(OBSERVATIONS_FILE) ?? '').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('f1');
  });

  test('F-0263 F-0395 proposals.json is suggested.json: the board of lessons', async () => {
    const { folder } = await filedAndAccepted();
    expect(SUGGESTED_FILE.path).toBe('suggested.json');
    expect(folder.raw(SUGGESTED_FILE)).toContain('Use bun, not Python, for scripts.');
    expect(folder.raw(SUGGESTED_FILE)).toContain('"format":1');
  });

  test('F-0270 F-0416 tombstones.json is dismissed.json: a rejected rule’s headstone', async () => {
    const lessons = store();
    await lessons.saveTombstones([{ identity: 'i1', titleHash: 'h', ruleGist: 'Use bun.', rejectedAt: AT }]);
    expect(DISMISSED_FILE.path).toBe('dismissed.json');
    expect((await lessons.loadTombstones()).map(entry => entry.identity)).toEqual(['i1']);
  });

  test('F-0269 F-0412 F-0268 F-0409 state.json holds the watermark and each ferret’s switch (today sessions.json)', async () => {
    const { host, ferrets, folder } = await filedAndAccepted();
    ferrets.add({ id: ferretId('f2'), name: 'kofi', folder: '/work/repo', state: 'stopped' });
    const switched = await host.request('PATCH', '/v1/ferrets/f2/lessons', { as: owner(), body: { passive: true } });
    expect(switched.status).toBe(200);
    expect(STATE_FILE.path).toBe('state.json');
    const raw = folder.raw(STATE_FILE) ?? '';
    expect(raw).toContain('"ferretId":"f2"');
    expect(raw).toContain('"format":1');
  });

  test('F-0261 F-0262 an accept records the rendered patch under patches/, named slug-instant (.json, not .md)', async () => {
    const folder = new MemoryStateFolder();
    const lessons = store(folder, '2026-11-07T10:00:00.000Z');
    const name = await lessons.writePatch('Use Bun!', '# Use bun\n');
    expect(PATCH_FILE.path).toBe('patches/*.json');
    expect(name).toBe('patches/use-bun-2026-11-07T10-00-00-000Z.json');
    expect(folder.raw(PATCH_FILE, 'use-bun-2026-11-07T10-00-00-000Z')).toContain('# Use bun');
    const accepted = await filedAndAccepted();
    expect([...accepted.folder.files.keys()].some(path => path.startsWith('patches/'))).toBe(true);
  });

  test('F-0264 F-0265 F-0266 F-0267 F-0048 F-0049 F-0379 runs/<run>/manifest.json is runs/<run>.json', async () => {
    const folder = new MemoryStateFolder();
    const lessons = store(folder);
    await lessons.writeRunManifest(manifestOf('scan-1-b0'));
    expect(RUN_FILE.path).toBe('runs/*.json');
    expect(await lessons.runIds()).toEqual(['scan-1-b0']);
    expect((await lessons.readRunManifest('scan-1-b0'))?.runId).toBe('scan-1-b0');
    expect((await lessons.latestRunManifest())?.runId).toBe('scan-1-b0');
    // A run id names a file: anything but a path-safe segment is refused.
    await expect(lessons.writeRunManifest(manifestOf('../escape'))).rejects.toThrow('path-safe');
  });

  test('F-0055 F-0057 F-0093 runs/<run>/digests.json is digests/<run>.json', async () => {
    const folder = new MemoryStateFolder();
    const lessons = store(folder);
    await lessons.writeDigests('scan-1-b0', []);
    expect(DIGESTS_FILE.path).toBe('digests/*.json');
    expect(await lessons.readDigests('scan-1-b0')).toEqual([]);
    expect(folder.raw(DIGESTS_FILE, 'scan-1-b0')).toContain('"format":1');
  });

  test('F-0051 F-0095 a session’s events.jsonl is read through Conversation’s transcript, never as a file', async () => {
    const asked: string[] = [];
    const ferrets = {
      get: async (id: string) => ({
        id,
        name: 'hadi',
        folder: '/w',
        state: 'stopped',
        role: 'lead',
        harness: 'claude-code',
        runner: 'tmux',
        createdAt: AT,
        stateAt: AT,
        mode: 'interactive',
      }),
      list: async () => [],
      start: async () => ({ ok: false }),
      stop: async () => {},
    };
    const miner = new LessonsMiner({
      store: new FakeLessonsStore(),
      ferrets: ferrets as never,
      conversation: {
        transcript: async (ferretId: string) => {
          asked.push(ferretId);
          return { ok: true, value: { messages: [{ role: 'user', text: 'Use bun.', timestamp: AT }] } };
        },
        sends: async () => ({ sends: [] }),
      } as never,
      roots: { root: () => ({}) as never },
      config: () => CONFIG,
      now: () => AT,
    });
    expect(await miner.digestCharacters('f1')).toBeGreaterThan(0);
    expect(asked).toEqual(['f1']);
  });

  test('the Global document is global.json, the plugin’s own state', () => {
    expect(GLOBAL_FILE.path).toBe('global.json');
  });

  test.skip('F-0056 F-0058 F-0387 a miner’s observations.json in its own run folder … pending port: Ferrets start work folder (D2 #19)', () => {});
});
