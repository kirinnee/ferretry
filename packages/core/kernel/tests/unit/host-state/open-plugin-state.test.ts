import { describe, expect, test } from 'bun:test';
import { instantFromEpochMs } from '@ferretry/std';
import { homeLockedSentence } from '../../../host/state/home-lock.ts';
import { assertRecordSize, scanJsonl } from '../../../host/state/jsonl-scan.ts';
import { moveStateAside, openPluginState } from '../../../host/state/open-plugin-state.ts';
import { allFiles, HOME, memoryStore, rulesFile } from './support.ts';

const clock = { now: () => instantFromEpochMs(Date.UTC(2026, 10, 7, 9, 5)) };
const open = (fs: ReturnType<typeof memoryStore>['fs'], over: Partial<Parameters<typeof openPluginState>[0]> = {}) =>
  openPluginState({
    home: HOME,
    pluginId: 'demo',
    files: allFiles,
    fs,
    clock,
    kind: 'plugin',
    liveTargets: false,
    ...over,
  });

describe('openPluginState: the boot check (§9.3)', () => {
  test('an empty plugin folder with a required file missing is damaged (missing)', async () => {
    const { fs } = memoryStore();
    const opened = await open(fs);
    expect(opened.damaged.map(d => d.reason)).toEqual(['missing']);
    expect(opened.moveAside).toBeUndefined();
  });

  test('a healthy folder (collections and jsonl included) opens with no damage', async () => {
    const { fs, path } = memoryStore();
    fs.seed(path('required.json'), '{"format":1,"count":1}');
    fs.seed(path('cards/a.json'), '{"format":1,"count":1}');
    fs.seed(path('log.jsonl'), '{"format":1,"count":1}\n');
    fs.seed(path('message-token.key'), 'not json at all');
    expect((await open(fs)).damaged).toEqual([]);
  });

  test('a lower format in a plugin with no live targets: every file is named and the folder is to move aside', async () => {
    const { fs, path } = memoryStore();
    fs.seed(path('required.json'), '{"format":1,"count":1}');
    fs.seed(path('counter.json'), '{"format":1,"count":1}');
    const opened = await open(fs);
    expect(opened.damaged.map(d => d.reason)).toEqual(['lower_format']);
    expect(opened.moveAside?.from).toBe(`${HOME}/state/demo`);
    expect(opened.moveAside?.to).toBe(`${HOME}/state/demo-before-2026-11-07-0905`);
    expect(opened.moveAside?.sentence).toContain('moved aside');
  });

  test('a lower format in a CORE piece is damaged, never moved', async () => {
    const { fs, path } = memoryStore();
    fs.seed(path('required.json'), '{"format":1,"count":1}');
    fs.seed(path('counter.json'), '{"format":1,"count":1}');
    const opened = await open(fs, { kind: 'core' });
    expect(opened.damaged).toHaveLength(1);
    expect(opened.moveAside).toBeUndefined();
  });

  test('a lower format in a tool plugin with live targets is damaged until none are live', async () => {
    const { fs, path } = memoryStore();
    fs.seed(path('required.json'), '{"format":1,"count":1}');
    fs.seed(path('counter.json'), '{"format":1,"count":1}');
    const opened = await open(fs, { liveTargets: true });
    expect(opened.damaged).toHaveLength(1);
    expect(opened.moveAside).toBeUndefined();
  });

  test('a higher format, or anything unreadable beside a lower one, moves nothing', async () => {
    const higher = memoryStore();
    higher.fs.seed(higher.path('required.json'), '{"format":1,"count":1}');
    higher.fs.seed(higher.path('counter.json'), '{"format":9,"count":1}');
    expect((await open(higher.fs)).moveAside).toBeUndefined();

    const mixed = memoryStore();
    mixed.fs.seed(mixed.path('required.json'), '{"format":0,"count":1}');
    mixed.fs.seed(mixed.path('counter.json'), '{ torn');
    const opened = await open(mixed.fs);
    expect(opened.damaged.map(d => d.reason).toSorted()).toEqual(['lower_format', 'unparsable']);
    expect(opened.moveAside).toBeUndefined();
  });

  test('the port starts with what boot found, so damaged() is right before the first read', async () => {
    const { fs, path, port: _ } = memoryStore();
    fs.seed(path('required.json'), '{"format":1,"count":1}');
    fs.seed(path('counter.json'), '{ torn');
    const opened = await open(fs);
    const { createStatePort } = await import('../../../host/state/state-port.ts');
    const port = createStatePort({ home: HOME, pluginId: 'demo', files: allFiles, fs, initialDamage: opened.damaged });
    expect(port.damaged()).toEqual(opened.damaged);
  });

  test('narrower parse, schema and lower-format findings never damage or move aside the subsystem', async () => {
    for (const text of ['{ broken', '{"format":1,"rules":1}', '{"format":0,"rules":[]}']) {
      const { fs, path } = memoryStore();
      fs.seed(path('sign-in-rules.json'), text);
      const opened = await open(fs, { files: [rulesFile] });
      expect(opened.damaged).toEqual([]);
      expect(opened.narrowed).toHaveLength(1);
      expect(opened.moveAside).toBeUndefined();
    }
  });

  test('moving aside renames the folder, narrows it to 0700 and leaves an empty folder to start in', async () => {
    const { fs, path } = memoryStore();
    fs.seed(path('counter.json'), '{"format":1,"count":1}');
    const to = `${HOME}/state/demo-before-2026-11-07-0905`;
    await moveStateAside(fs, { from: `${HOME}/state/demo`, to });
    expect(fs.snapshot().get(`${to}/counter.json`)).toBe('{"format":1,"count":1}');
    expect(fs.snapshot().has(path('counter.json'))).toBe(false);
    expect(fs.modeOf(to)).toBe(0o700);
    expect(fs.modeOf(`${HOME}/state/demo`)).toBe(0o700);
  });

  test('moving aside never overwrites a folder that is already there', async () => {
    const { fs, path } = memoryStore();
    fs.seed(path('counter.json'), 'x');
    const to = `${HOME}/state/demo-before-2026-11-07-0905`;
    fs.seed(`${to}/old.json`, 'y');
    await expect(moveStateAside(fs, { from: `${HOME}/state/demo`, to })).rejects.toThrow('already exists');
    expect(fs.snapshot().get(path('counter.json'))).toBe('x');
  });
});

describe('the jsonl line scan', () => {
  test('records, a torn tail and a bad middle line are told apart', () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(scanJsonl(encode('{"a":1}\n{"a":2}\n')).records).toHaveLength(2);
    const torn = scanJsonl(encode('{"a":1}\n{"a":'));
    expect(torn.tornTail).toBe(true);
    expect(torn.problems).toEqual([]);
    const bad = scanJsonl(encode('{"a":1}\nnope\n{"a":3}\n'));
    expect(bad.problems.map(p => p.line)).toEqual([2]);
    expect(scanJsonl(encode('{"a":1}\n\n\n{"a":2}\n')).records).toHaveLength(2);
  });

  test('a record over the cap is a problem, and the encoder refuses to write one', () => {
    const line = JSON.stringify({ text: 'x'.repeat(100) });
    expect(scanJsonl(new TextEncoder().encode(`${line}\n`), { maxRecordBytes: 50 }).problems).toHaveLength(1);
    expect(() => assertRecordSize(line, 50)).toThrow('exceeds the maximum');
  });
});

describe('the home lock sentence', () => {
  test('G57 a daemon that cannot claim its home names `fy daemon adopt`', () => {
    const sentence = homeLockedSentence('/home/fy', '/home/fy/run/daemon.lock', 'fy');
    expect(sentence).toContain('`fy daemon adopt`');
    expect(sentence).toContain('/home/fy/run/daemon.lock');
  });
});
