import { describe, expect, it } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { LESSONS_STATE, STATE_FILE } from '../../contract/index.ts';
import { StateLessonsStore } from '../../daemon/adapters/state-store.ts';
import { AT, observation, proposal } from './support.ts';

const store = (folder = new MemoryStateFolder()) =>
  new StateLessonsStore({ state: folder.port(LESSONS_STATE), clock: { now: () => AT } } as never);

describe('StateLessonsStore', () => {
  it('reads an empty board before anything is stored', async () => {
    const lessons = store();
    expect(await lessons.loadProposals()).toEqual([]);
    expect(await lessons.loadTombstones()).toEqual([]);
    expect(await lessons.readObservations()).toEqual([]);
    expect(await lessons.readGlobal()).toBeUndefined();
  });

  it('keeps each ferret’s switch and the board state in one file, and no machine switch (lessons.yaml owns it)', async () => {
    const folder = new MemoryStateFolder();
    const lessons = store(folder);
    await lessons.saveFerretLessons([{ ferretId: 'f1', passive: true, since: AT, setBy: 'owner' }]);
    await lessons.saveState({ ...(await lessons.loadState()), lastRunAt: AT });
    expect((await lessons.loadFerretLessons()).map(entry => entry.ferretId)).toEqual(['f1']);
    expect((await lessons.loadState()).lastRunAt).toBe(AT);
    expect(folder.raw(STATE_FILE)).toContain('"format":1');
    expect(folder.raw(STATE_FILE)).not.toContain('passiveDefault');
  });

  it('stores proposals and evidence, and appends observations without duplicating', async () => {
    const lessons = store();
    await lessons.saveProposals([proposal({ id: 'p1' })]);
    expect((await lessons.loadProposals()).map(entry => entry.id)).toEqual(['p1']);
    const first = await lessons.appendObservations([observation({ id: 'o1' })]);
    expect(first.map(entry => entry.id)).toEqual(['o1']);
    const again = await lessons.appendObservations([observation({ id: 'o1' }), observation({ id: 'o2' })]);
    expect(again.map(entry => entry.id)).toEqual(['o2']);
    expect([...(await lessons.observationsById()).keys()].sort()).toEqual(['o1', 'o2']);
  });

  it('keeps the Global lessons document and refuses a run id that is not a path-safe segment', async () => {
    const lessons = store();
    await lessons.writeGlobal('# Lessons\n- Use bun.\n');
    expect(await lessons.readGlobal()).toBe('# Lessons\n- Use bun.\n');
    await expect(lessons.readRunManifest('../escape')).rejects.toThrow('path-safe');
  });

  it('says a damaged file is damaged rather than reading it as an empty board', async () => {
    const folder = new MemoryStateFolder();
    folder.plant(STATE_FILE, '{ not json');
    await expect(store(folder).loadState()).rejects.toThrow();
  });
});
