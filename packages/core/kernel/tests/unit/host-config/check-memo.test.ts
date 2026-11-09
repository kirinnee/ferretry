/**
 * What the config files remember of their checks, and how the disk and a patch are read, all bounded:
 *
 * - the check memo holds only what a load settled, by digest: refused writes under new names leave nothing behind
 *   (2 000 of them once grew the daemon by 740 MB), and a refused text — a raw secret above all — is never reachable
 *   from it, as a key or as a value;
 * - a file is read with a hard byte bound, so one that grows after its size was read is never read whole;
 * - a plugin's patch of a hand-written broken file parses it once, not twice.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineConfig } from '../../../contract/index.ts';
import { CHECKS_KEPT, type ConfigCheckMemo, createConfigCheckMemo } from '../../../host/config/check-memo.ts';
import type { checkConfigText } from '../../../host/config/check.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { CONFIG_FILE_MAX_BYTES, editConfigText, readConfigText, readConfigTextToEdit } from '@ferretry/std/yaml';
import type { HostFs } from '../../../host/state/host-fs.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { PRIVATE_WORD } from './adversarial-texts.ts';
import { captureLog, HOME, loginsDef, manualClock } from './support.ts';

type Checked = ReturnType<typeof checkConfigText>;

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const VOICE = `${HOME}/config/voice.yaml`;

const voiceDef = defineConfig({
  file: 'voice.yaml',
  schema: z.strictObject({ limit: z.number().int().default(10), note: z.unknown().optional() }),
  axis: 'configure',
  loosens: () => [],
});

/** A memo that records every check it is asked to keep, so a test can inspect all it ever held. */
function spyMemo(): ConfigCheckMemo & { readonly kept: { path: string; digest: string; checked: Checked }[] } {
  const inner = createConfigCheckMemo();
  const kept: { path: string; digest: string; checked: Checked }[] = [];
  return {
    kept,
    get: (path, key) => inner.get(path, key),
    keep: (path, key, checked) => {
      kept.push({ path, digest: key, checked });
      inner.keep(path, key, checked);
    },
    keepOnly: present => inner.keepOnly(present),
    size: () => inner.size(),
  };
}

function world(options: { fs?: HostFs & { seed(path: string, data: string): void } } = {}) {
  const fs = options.fs ?? createMemoryHostFs();
  const checks = spyMemo();
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    checks,
    defs: [
      { plugin: 'voice', def: voiceDef },
      { plugin: 'logins', def: loginsDef },
    ],
  });
  return { fs, files, checks };
}

/** A fake key of a shape the raw-secret scan knows, built at run time (never a real one). */
const fakeKey = (): string => `sk-ant-api03-${'Q7xR2m'.repeat(8)}`;

function timedSync(act: () => unknown): number {
  const started = performance.now();
  act();
  return performance.now() - started;
}

describe('the check memo itself', () => {
  const checked = (n: number): Checked => ({
    ok: false,
    reason: 'schema',
    issues: [{ path: String(n), severity: 'error', message: 'm', fix: 'f' }],
  });

  test(`keeps at most ${String(CHECKS_KEPT)} checks per file, the newest`, () => {
    const memo = createConfigCheckMemo();
    for (let n = 0; n < 10; n += 1) memo.keep('a.yaml', `d${String(n)}`, checked(n));
    expect(memo.size()).toBe(CHECKS_KEPT);
    expect(memo.get('a.yaml', 'd9')).toBeDefined();
    expect(memo.get('a.yaml', 'd6')).toBeUndefined();
  });

  test('keeping a digest again makes it the newest, and keepOnly forgets every other file', () => {
    const memo = createConfigCheckMemo();
    memo.keep('a.yaml', 'd1', checked(1));
    memo.keep('a.yaml', 'd2', checked(2));
    memo.keep('a.yaml', 'd3', checked(3));
    memo.keep('a.yaml', 'd1', checked(1));
    memo.keep('a.yaml', 'd4', checked(4));
    expect(memo.get('a.yaml', 'd1')).toBeDefined();
    expect(memo.get('a.yaml', 'd2')).toBeUndefined();
    memo.keep('b.yaml', 'd1', checked(1));
    memo.keepOnly(new Set(['b.yaml']));
    expect(memo.size()).toBe(1);
    expect(memo.get('a.yaml', 'd1')).toBeUndefined();
  });
});

describe('the memo holds only what a load settled', () => {
  test('T-0034 2 000 refused config_write calls under new names leave the memo empty and the heap flat', async () => {
    const { files, checks } = world();
    await files.reload();
    const writer = files.writer();
    const write = async (n: number) =>
      await writer.write(
        { plugin: 'logins', def: loginsDef, name: `n${String(n)}` },
        // About 250 KiB that fails its schema: an unknown key and a wrong type.
        `budget: "${String(n)}"\nnote: ${'x'.repeat(250 * 1024)}\n`,
        { byAgent: true },
      );
    // Warm up, then measure.
    for (let n = 0; n < 50; n += 1) expect((await write(n)).kind).toBe('refused');
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    for (let n = 50; n < 2_050; n += 1) await write(n);
    Bun.gc(true);
    const grown = process.memoryUsage().heapUsed - before;
    // Before: every refused text (and its issues) stayed, about 500 MB for these 2 000.
    expect(checks.size()).toBe(0);
    expect(checks.kept.filter(item => item.path.startsWith('logins/'))).toEqual([]);
    expect(grown).toBeLessThan(64 * 1024 * 1024);
  }, 120_000);

  test('T-0034 the memo never holds more than the files settled, times the per-file cap', async () => {
    const { fs, files, checks } = world();
    for (let n = 0; n < 12; n += 1) fs.seed(`${HOME}/config/logins/f${String(n)}.yaml`, `budget: ${String(n)}\n`);
    await files.reload();
    for (let round = 0; round < 5; round += 1) {
      for (let n = 0; n < 12; n += 1)
        await files.write('logins', loginsDef, `f${String(n)}`, `budget: ${String(n + round * 100)}\n`, {
          confirmedLoosening: true,
        });
    }
    const settled = files.status().files.length;
    expect(checks.size()).toBeLessThanOrEqual(CHECKS_KEPT * settled);
    // A file removed is forgotten at the next load.
    for (let n = 0; n < 12; n += 1)
      await files.remove('logins', loginsDef, `f${String(n)}`, { confirmedLoosening: true });
    await files.reload();
    expect(checks.size()).toBeLessThanOrEqual(CHECKS_KEPT * files.status().files.length);
  });

  test('T-0034 a refused raw secret is not reachable from the memo, as a key or as a value', async () => {
    const { fs, files, checks } = world();
    fs.seed(VOICE, 'limit: 7\n');
    await files.reload();
    const key = fakeKey();
    const secretText = `limit: 8\nnote: ${key}\n# ${PRIVATE_WORD}\n`;
    // Through the agent's door to a NEW name, to an existing file, and as a hand-written file a load reads.
    const toNew = await files
      .writer()
      .write({ plugin: 'logins', def: loginsDef, name: 'fresh' }, `model: ${key}\n# ${PRIVATE_WORD}\n`, {
        byAgent: true,
      });
    expect(toNew).toMatchObject({ kind: 'refused', reason: 'raw_secret' });
    const toExisting = await files.writer().write({ plugin: 'voice', def: voiceDef }, secretText, { byAgent: true });
    expect(toExisting).toMatchObject({ kind: 'refused', reason: 'raw_secret' });
    expect(checks.get('voice.yaml', digest(secretText))).toBeUndefined();
    fs.seed(`${HOME}/config/logins/hand.yaml`, `model: ${key}\n# ${PRIVATE_WORD}\n`);
    await files.reload();
    // Everything the memo was EVER asked to keep: digests for keys, and no refused check carries a text.
    const everything = JSON.stringify(checks.kept);
    expect(everything).not.toContain(key);
    expect(everything).not.toContain(PRIVATE_WORD);
    for (const item of checks.kept) {
      expect(item.digest).toMatch(/^[0-9a-f]{64}$/u);
      if (!item.checked.ok) expect(Object.keys(item.checked).toSorted()).toEqual(['issues', 'ok', 'reason']);
    }
    expect(files.port('voice').file(voiceDef)?.limit).toBe(7);
  });

  test('T-0034 a write that lands is kept by the load that follows it, under its digest', async () => {
    const { files, checks } = world();
    await files.reload();
    const text = 'limit: 4\n';
    expect((await files.write('voice', voiceDef, undefined, text)).kind).toBe('applied');
    expect(checks.get('voice.yaml', digest(text))?.ok).toBe(true);
  });
});

describe('a file is read with a hard byte bound', () => {
  const over = `note: ${PRIVATE_WORD}\n${'#'.repeat(CONFIG_FILE_MAX_BYTES)}`;

  test('T-0032 a file that grows after its size was read is read no further than one byte past the cap', async () => {
    const memory = createMemoryHostFs();
    const tails: { path: string; maxBytes: number; got: number }[] = [];
    const whole: string[] = [];
    const watched: HostFs & { seed(path: string, data: string): void } = {
      ...memory,
      // The size the daemon reads first says the file is small; the bytes it then reads are not.
      info: async path => {
        const info = await memory.info(path);
        return info === undefined ? undefined : { ...info, size: 1 };
      },
      readTail: async (path, maxBytes) => {
        const read = await memory.readTail(path, maxBytes);
        tails.push({ path, maxBytes, got: read?.bytes.byteLength ?? 0 });
        return read;
      },
      readText: async path => {
        whole.push(path);
        return await memory.readText(path);
      },
    };
    const { fs, files } = world({ fs: watched });
    fs.seed(VOICE, 'limit: 7\n');
    await files.reload();
    fs.seed(VOICE, `${over}${'#'.repeat(4 * CONFIG_FILE_MAX_BYTES)}`);
    await files.reload();
    expect(files.port('voice').file(voiceDef)?.limit).toBe(7);
    expect(files.status().files.find(file => file.path === 'voice.yaml')?.state).toBe('invalid');
    expect(whole.filter(path => path === VOICE)).toEqual([]);
    const ofVoice = tails.filter(item => item.path === VOICE);
    expect(ofVoice.length).toBeGreaterThan(0);
    for (const item of ofVoice) {
      expect(item.maxBytes).toBe(CONFIG_FILE_MAX_BYTES + 1);
      expect(item.got).toBeLessThanOrEqual(CONFIG_FILE_MAX_BYTES + 1);
    }
    expect(JSON.stringify(files.status())).not.toContain(PRIVATE_WORD);
  });

  test('T-0032 a file at exactly the cap is read; one byte more is not', async () => {
    const { fs, files } = world();
    const at = `limit: 3\nnote: ${'a'.repeat(CONFIG_FILE_MAX_BYTES - 'limit: 3\nnote: '.length)}`;
    fs.seed(VOICE, at);
    await files.reload();
    expect(files.port('voice').file(voiceDef)?.limit).toBe(3);
    fs.seed(VOICE, `${at}a`);
    await files.reload();
    expect(files.port('voice').file(voiceDef)?.limit).toBe(3);
    expect(files.status().files.find(file => file.path === 'voice.yaml')?.state).toBe('invalid');
  });
});

describe("a plugin's patch of a hand-written broken file parses it once", () => {
  /** Hand-written files an edit replaces whole: not YAML, a key twice, over the cap. */
  const broken = [
    ['quote soup', `limit: 7\n${'" : \' '.repeat(Math.floor((CONFIG_FILE_MAX_BYTES - 10) / 6))}`],
    ['broken lines', `limit: 7\n${'"\n'.repeat(Math.floor((CONFIG_FILE_MAX_BYTES - 10) / 2))}`],
    ['a key twice', 'limit: 7\nlimit: 8\n'],
    ['over the cap', `limit: 7\n${'#'.repeat(CONFIG_FILE_MAX_BYTES)}`],
  ] as const;

  test('the one-parse read edits to exactly the text the two-parse edit made', () => {
    for (const [, text] of broken) {
      const { read, base } = readConfigTextToEdit(text);
      expect(read.ok).toBe(false);
      expect(base).toBeUndefined();
      expect(editConfigText(base, { limit: 3 }, { limit: 10 }, '# m')).toBe(
        editConfigText(text, { limit: 3 }, { limit: 10 }, '# m'),
      );
    }
    // A file whose structure an edit keeps is handed on whole: an alias that names nothing still parses.
    for (const text of ['limit: 7 # mine\n', 'limit: 7\nnote: *nowhere\n']) {
      const { read, base } = readConfigTextToEdit(text);
      expect(read.ok).toBe(readConfigText(text).ok);
      expect(base).toBe(text);
    }
  });

  test('T-0034 the patch write of a 256 KiB broken file costs one parse, not two', async () => {
    // A wall-clock bound is a measurement of the box as much as of the code (5.3 s under load, 0.3 s alone), so the
    // bound is a RATIO to what one parse costs on this box right now, and a noisy attempt is measured again: parsing
    // twice costs about 2x in every attempt, a busy moment costs one.
    const ATTEMPTS = 3;
    for (const [label, text] of broken.slice(0, 2)) {
      let best = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < ATTEMPTS && best >= 1.6; attempt += 1) {
        const { fs, files } = world();
        fs.seed(VOICE, 'limit: 7\n');
        await files.reload();
        fs.seed(VOICE, text);
        await files.reload();
        // What ONE parse of this text costs on this box, now: the floor the patch write must stay near.
        const once = Math.min(
          timedSync(() => readConfigText(text)),
          timedSync(() => readConfigText(text)),
        );
        Bun.gc(true);
        const started = performance.now();
        const outcome = await files.port('voice').write(voiceDef, undefined, { patch: { limit: 3 } });
        const spent = performance.now() - started;
        expect(outcome.kind, label).toBe('written');
        expect(files.port('voice').file(voiceDef)?.limit).toBe(3);
        // A little over one parse: two parses of the file took 1.06–1.24 s on a loaded box and cost twice `once`.
        best = Math.min(best, (spent - 100) / Math.max(once, 1));
      }
      expect(best, label).toBeLessThan(1.6);
    }
  }, 120_000);
});
