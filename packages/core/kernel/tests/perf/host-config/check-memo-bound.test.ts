/**
 * The SPEED / SIZE half of `../../unit/host-config/check-memo.test.ts`: 2 000 refused writes of 250 KiB leave the heap
 * flat, and a patch write of a 256 KiB broken file costs one parse, not two. What stays in the memo, and that the patch
 * lands, are held here at the full size and in unit at a small one.
 */
import { describe, expect, test } from 'bun:test';
import { CONFIG_FILE_MAX_BYTES, readConfigText } from '@ferretry/std/yaml';
import { brokenTexts, refuseWrites, VOICE, voiceDef, world } from '../../unit/host-config/check-memo-support.ts';

function timedSync(act: () => unknown): number {
  const started = performance.now();
  act();
  return performance.now() - started;
}

describe('the memo holds only what a load settled', () => {
  test('T-0034 2 000 refused config_write calls under new names leave the heap flat', async () => {
    const { files, checks } = world();
    await files.reload();
    // Warm up (250 KiB each), then measure.
    const warmed = await refuseWrites(
      files,
      Array.from({ length: 50 }, (_, n) => n),
      250 * 1024,
    );
    expect(warmed).toEqual(Array.from({ length: 50 }, () => 'refused'));
    Bun.gc(true);
    const before = process.memoryUsage().heapUsed;
    await refuseWrites(
      files,
      Array.from({ length: 2_000 }, (_, n) => n + 50),
      250 * 1024,
    );
    Bun.gc(true);
    const grown = process.memoryUsage().heapUsed - before;
    // Before: every refused text (and its issues) stayed, about 500 MB for these 2 000.
    expect(checks.size()).toBe(0);
    expect(checks.kept.filter(item => item.path.startsWith('logins/'))).toEqual([]);
    expect(grown).toBeLessThan(64 * 1024 * 1024);
  }, 120_000);
});

describe("a plugin's patch of a hand-written broken file parses it once", () => {
  test('T-0034 the patch write of a 256 KiB broken file costs one parse, not two', async () => {
    // A wall-clock bound is a measurement of the box as much as of the code (5.3 s under load, 0.3 s alone), so the
    // bound is a RATIO to what one parse costs on this box right now, and a noisy attempt is measured again: parsing
    // twice costs about 2x in every attempt, a busy moment costs one.
    const ATTEMPTS = 3;
    for (const [label, text] of brokenTexts(CONFIG_FILE_MAX_BYTES).slice(0, 2)) {
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
