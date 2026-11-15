import { describe, expect, test } from 'bun:test';
import {
  MachineScripts,
  SCRIPT_RECORD_MAX_HOSTS,
  type ScriptRecordSnapshot,
  type ScriptRecordStore,
} from '../../../../daemon/lib/inputs/machine-scripts.ts';

/** A record store in RAM: what was saved, and what a restart would read. */
function store(initial: ScriptRecordSnapshot | 'damaged' | undefined = undefined) {
  const saved: ScriptRecordSnapshot[] = [];
  const fake = {
    saved,
    loads: 0,
    failLoad: false,
    failSave: false,
    initial,
    async load() {
      fake.loads += 1;
      if (fake.failLoad) throw new Error('io');
      return fake.initial;
    },
    async save(record: ScriptRecordSnapshot) {
      if (fake.failSave) throw new Error('io');
      saved.push(record);
      fake.initial = record;
    },
  };
  return fake satisfies ScriptRecordStore & { saved: ScriptRecordSnapshot[] };
}

describe('the page-script record', () => {
  test('with no store it is the RAM record and load is nothing to do', async () => {
    const scripts = new MachineScripts(() => 10);
    await scripts.load();
    scripts.scriptedOn('github.com');
    scripts.scriptedOn(undefined);
    const end = scripts.running();
    end();
    end();
    await scripts.settled();

    expect(scripts.scriptedOrigins()).toEqual({ hosts: new Map([['github.com', 10]]), everywhere: 10 });
  });

  test('reports are written, and a new instance reads them back at load (a daemon restart)', async () => {
    const kept = store();
    const first = new MachineScripts(() => 10, kept);
    await first.load();
    first.scriptedOn('github.com');
    first.scriptedOn(undefined);
    await first.settled();

    const second = new MachineScripts(() => 20, kept);
    await second.load();

    expect(kept.saved.at(-1)).toEqual({ hosts: new Map([['github.com', 10]]), everywhere: 10 });
    expect(second.scriptedOrigins()).toEqual({ hosts: new Map([['github.com', 10]]), everywhere: 10 });
  });

  test('a record with no unreadable-origin time reads back without one', async () => {
    const second = new MachineScripts(() => 20, store({ hosts: new Map([['a.com', 5]]) }));
    await second.load();

    expect(second.scriptedOrigins()).toEqual({ hosts: new Map([['a.com', 5]]) });
  });

  test('it never writes before it has read: a report that comes first waits, and joins, the file', async () => {
    const kept = store({
      hosts: new Map([
        ['old.com', 3],
        ['github.com', 4],
      ]),
      everywhere: 2,
    });
    const scripts = new MachineScripts(() => 10, kept);
    scripts.scriptedOn('github.com');
    await Promise.resolve();
    expect(kept.saved).toEqual([]);

    await scripts.load();
    await scripts.settled();

    expect(kept.saved).toEqual([
      {
        hosts: new Map([
          ['old.com', 3],
          ['github.com', 10],
        ]),
        everywhere: 2,
      },
    ]);
  });

  test('an older time in the file never moves a newer one back', async () => {
    const kept = store({ hosts: new Map([['github.com', 4]]), everywhere: 3 });
    const scripts = new MachineScripts(() => 10, kept);
    scripts.scriptedOn('github.com');
    scripts.scriptedOn(undefined);
    await scripts.load();

    expect(scripts.scriptedOrigins()).toEqual({ hosts: new Map([['github.com', 10]]), everywhere: 10 });
  });

  test('until the record has been read, every place counts as scripted just now', async () => {
    const scripts = new MachineScripts(() => 77, store());

    expect(scripts.scriptedOrigins().everywhere).toBe(77);
    await scripts.load();
    expect(scripts.scriptedOrigins().everywhere).toBeUndefined();
  });

  test.each([
    ['a damaged file', 'damaged' as const, false],
    ['a store that throws', undefined, true],
  ])('%s fails closed (everywhere, just now) and says so without a host name', async (_name, initial, failLoad) => {
    const kept = store(initial);
    kept.failLoad = failLoad;
    const warned: string[] = [];
    let now = 50;
    const scripts = new MachineScripts(
      () => now,
      kept,
      sentence => void warned.push(sentence),
    );

    await scripts.load();
    now = 60;
    scripts.scriptedOn('github.com');
    await scripts.settled();

    expect(scripts.scriptedOrigins().everywhere).toBe(60);
    expect(warned.length).toBeGreaterThanOrEqual(1);
    expect(warned.join(' ')).not.toContain('github');
  });

  test('a write that fails is said, never thrown, and the RAM record still holds', async () => {
    const kept = store();
    kept.failSave = true;
    const warned: string[] = [];
    const scripts = new MachineScripts(
      () => 10,
      kept,
      sentence => void warned.push(sentence),
    );
    await scripts.load();

    scripts.scriptedOn('github.com');
    await scripts.settled();

    expect(warned).toHaveLength(1);
    expect(warned[0]).not.toContain('github');
    expect(scripts.scriptedOrigins().hosts.get('github.com')).toBe(10);
  });

  test('it keeps the newest hosts and folds an older one into "somewhere unreadable then"', async () => {
    let now = 1_000;
    const scripts = new MachineScripts(() => now, store());
    await scripts.load();
    for (let i = 0; i < SCRIPT_RECORD_MAX_HOSTS + 2; i += 1) {
      now = 1_000 + i;
      scripts.scriptedOn(`h${i}.example`);
    }
    await scripts.settled();

    const view = scripts.scriptedOrigins();
    expect(view.hosts.size).toBe(SCRIPT_RECORD_MAX_HOSTS);
    expect(view.hosts.has('h0.example')).toBe(false);
    expect(view.hosts.has(`h${SCRIPT_RECORD_MAX_HOSTS + 1}.example`)).toBe(true);
    // The two oldest are gone, so any rule approved at or before the second one's time is refused everywhere.
    expect(view.everywhere).toBe(1_001);
  });

  test('a file with more hosts than the bound is cut the same way at load', async () => {
    const hosts = new Map<string, number>();
    for (let i = 0; i < SCRIPT_RECORD_MAX_HOSTS + 1; i += 1) hosts.set(`h${i}.example`, 100 + i);
    const scripts = new MachineScripts(() => 5, store({ hosts }));

    await scripts.load();

    expect(scripts.scriptedOrigins().hosts.size).toBe(SCRIPT_RECORD_MAX_HOSTS);
    expect(scripts.scriptedOrigins().everywhere).toBe(100);
  });

  test('a script running now is reported until it ends, and is not kept across a restart', async () => {
    const kept = store();
    const scripts = new MachineScripts(() => 10, kept);
    await scripts.load();
    const end = scripts.running();
    expect(scripts.scriptedOrigins().running).toBe(true);
    end();
    expect(scripts.scriptedOrigins().running).toBeUndefined();
  });
});
