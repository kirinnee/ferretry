/**
 * Finding 6 (safety): a scan miner never runs in, or writes to, an owner's project. Today's miner runs in the daemon's
 * home and writes under `state/learning/runs/<run>/`; here it needs a folder of Lessons' own, which this base cannot give
 * a ferret (D2 #19), so every miner start REFUSES before anything is written. When a folder of its own exists, the miner
 * runs there and on the scan's model.
 */
import { describe, expect, it } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { LESSONS_MINER_GAP } from '../../contract/index.ts';
import { LessonsMiner, type MinerDependencies } from '../../daemon/adapters/miner.ts';
import { LessonsError } from '../../daemon/lib/index.ts';
import { AT, FakeLessonsStore, LESSONS_CONFIG } from './support.ts';

const OWNER_PROJECT = '/home/owner/Workspace/repo';

function miner(minerFolder?: MinerDependencies['minerFolder']) {
  const ferrets = new FakeFerrets();
  ferrets.add({
    id: ferretId('f-old'),
    folder: OWNER_PROJECT,
    state: 'stopped',
    mode: 'interactive',
    stateAt: AT as never,
  });
  const store = new FakeLessonsStore();
  const conversation = {
    transcript: async () => ({
      ok: true as const,
      value: { messages: [{ role: 'user' as const, text: 'Use bun, not Python, for scripts.', timestamp: AT }] },
    }),
    sends: async () => ({ sends: [] }),
  };
  const subject = new LessonsMiner({
    store,
    ferrets,
    conversation: conversation as never,
    roots: { root: () => ({}) as never },
    config: () => ({ ...LESSONS_CONFIG, model: 'claude-haiku-5-5' }),
    now: () => AT,
    ...(minerFolder === undefined ? {} : { minerFolder }),
  });
  return { subject, ferrets, store };
}

describe('the lesson miner (finding 6)', () => {
  it('refuses a scan batch with the gap sentence, starts no ferret and writes nothing', async () => {
    const { subject, ferrets, store } = miner();
    const started = subject.start('scan-1', 0, ['f-old'], 'claude', 'claude-haiku-5-5');
    await expect(started).rejects.toBeInstanceOf(LessonsError);
    await expect(started).rejects.toMatchObject({ reason: 'unavailable', message: LESSONS_MINER_GAP });
    expect(ferrets.starts).toEqual([]);
    expect(store.digests.size).toBe(0);
  });

  it('refuses a spawning run before the watermark moves, so no ferret is skipped for good', async () => {
    const { subject, ferrets, store } = miner();
    const before = await store.loadState();
    await expect(subject.run(true)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(await store.loadState()).toEqual(before);
    expect(ferrets.starts).toEqual([]);
  });

  it('still answers an ingest-only run', async () => {
    const { subject } = miner();
    expect((await subject.run(false)).minerFerrets).toEqual([]);
  });

  it('given a folder of its own, runs there — never the owner’s project — on the scan’s model', async () => {
    const { subject, ferrets } = miner(run => `/fy-home/state/lessons/runs/${run}`);
    await subject.start('scan-1', 0, ['f-old'], 'claude', 'claude-haiku-5-5');
    const [request] = ferrets.starts;
    expect(request?.folder).toBe('/fy-home/state/lessons/runs/scan-1-b0');
    expect(request?.folder.startsWith(OWNER_PROJECT)).toBe(false);
    expect(request?.prompt).toContain('/fy-home/state/lessons/runs/scan-1-b0/.fy-lessons-scan-1-b0.json');
    expect(request?.prompt).not.toContain(OWNER_PROJECT + '/.fy-lessons');
    expect(request?.options?.model).toBe('claude-haiku-5-5');
    expect(request?.by).toBe('owner');
  });
});
