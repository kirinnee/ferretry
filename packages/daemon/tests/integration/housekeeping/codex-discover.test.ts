/**
 * THE `codex.discover` JOB ON A REAL CODEX HOME (docs/design/housekeeping-worker.md §2.1).
 *
 * The job code the housekeeping worker runs, run here over real files: it answers the candidates outside
 * the baseline, how many listing changes its walk saw, and the frontier main watches — and the index the
 * host keeps between jobs means a second walk of an unchanged home opens nothing.
 */
import { afterAll, describe, it } from 'bun:test';
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import {
  HousekeepingCounters,
  hostHousekeepingPorts,
  InlineHousekeepingJobs,
  runHousekeepingJob,
} from '../../../src/adapters/housekeeping/index.ts';
import { NodeCodexRolloutIndex } from '../../../src/adapters/session/transcript/node-codex-rollout-index.ts';
import type { HousekeepingSettings } from '../../../src/lib/housekeeping/protocol.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const SETTINGS: HousekeepingSettings = {
  type: 'settings',
  platform: 'linux',
  keychainAccount: 'agent',
  defaultClaudeHome: '/nonexistent/.claude',
  fleetRoot: '/nonexistent/fleet',
};

const TOKEN = '/state/sessions/20261022-mine';

afterAll(async () => {
  await cleanupTempDirectories();
});

const uuid = (index: number): string => `${index.toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`;

/** One rollout as Codex writes it: a `session_meta` header, then ordinary records. */
async function writeRollout(home: string, day: string, id: string, body: readonly string[] = []): Promise<string> {
  const directory = join(home, 'sessions', day);
  await mkdir(directory, { recursive: true });
  const file = join(directory, `rollout-${day.replaceAll('/', '-')}-${id}.jsonl`);
  const lines = [JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/work/repo' } }), ...body];
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

/** Dates every directory an hour back, so the walk trusts its listings. */
async function settle(home: string): Promise<void> {
  const past = Date.now() / 1_000 - 3_600;
  const pending = [join(home, 'sessions')];
  while (pending.length > 0) {
    const directory = pending.shift() as string;
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
    await utimes(directory, past, past);
  }
}

describe('the codex.discover job', () => {
  it('should answer the candidates outside the baseline, the change it saw and the frontier', async () => {
    // Arrange: old days and a month boundary, a baseline, then this session's rollout.
    const home = await tempDirectory('fyd-codex-discover-');
    for (const [index, day] of ['2026/09/29', '2026/09/30', '2026/10/01', '2026/10/02'].entries())
      await writeRollout(home, day, uuid(index));
    await settle(home);
    const rollouts = new NodeCodexRolloutIndex();
    const baseline = await rollouts.ids(home);
    const mine = await writeRollout(home, '2026/10/02', uuid(99), [JSON.stringify({ text: `brief in ${TOKEN}` })]);
    const counters = new HousekeepingCounters();

    // Act
    const found = await runHousekeepingJob(hostHousekeepingPorts(SETTINGS, counters, { rollouts }), {
      kind: 'codex.discover',
      home,
      correlationToken: TOKEN,
      skip: baseline,
    });

    // Assert
    const root = join(home, 'sessions');
    should(found.candidates).eql([{ id: uuid(99), file: mine, correlated: true }]);
    should(found.changed).equal(1);
    should(found.frontier).eql([root, `${root}/2026`, `${root}/2026/10`, `${root}/2026/10/01`, `${root}/2026/10/02`]);
    should(counters.fileReads).be.above(0);
  });

  it('should open nothing on a second walk of an unchanged home, with the index kept between jobs', async () => {
    // Arrange
    const home = await tempDirectory('fyd-codex-discover-');
    for (let index = 0; index < 50; index += 1) await writeRollout(home, '2026/10/22', uuid(index));
    await settle(home);
    const rollouts = new NodeCodexRolloutIndex();
    const job = { kind: 'codex.discover', home, correlationToken: TOKEN, skip: [] } as const;
    await runHousekeepingJob(hostHousekeepingPorts(SETTINGS, new HousekeepingCounters(), { rollouts }), job);
    const counters = new HousekeepingCounters();

    // Act
    const found = await runHousekeepingJob(hostHousekeepingPorts(SETTINGS, counters, { rollouts }), job);

    // Assert
    should(found.candidates).have.length(50);
    should(found.changed).equal(0);
    should(counters.fileReads).equal(0);
  });

  it('should name only sessions as the frontier of a home with no rollouts yet', async () => {
    // Arrange: a Codex home that has never run a session.
    const home = await tempDirectory('fyd-codex-discover-');

    // Act
    const found = await runHousekeepingJob(hostHousekeepingPorts(SETTINGS, new HousekeepingCounters()), {
      kind: 'codex.discover',
      home,
      correlationToken: TOKEN,
      skip: [],
    });

    // Assert
    should(found).eql({ candidates: [], changed: 1, frontier: [join(home, 'sessions')] });
  });

  it('should run on the main thread over the index it was given, the one the start reads baselines with', async () => {
    // Arrange: the start's baseline read has already learned every rollout.
    const home = await tempDirectory('fyd-codex-discover-');
    for (let index = 0; index < 20; index += 1) await writeRollout(home, '2026/10/22', uuid(index));
    await settle(home);
    const rollouts = new NodeCodexRolloutIndex();
    const baseline = await rollouts.ids(home);
    const opened = rollouts.opened;
    const subject = new InlineHousekeepingJobs(SETTINGS, Date.now, rollouts);

    // Act
    const found = await subject.run({ kind: 'codex.discover', home, correlationToken: TOKEN, skip: baseline });

    // Assert: nothing outside the baseline, and not one rollout opened again.
    should(found.candidates).eql([]);
    should(rollouts.opened).equal(opened);
  });
});
