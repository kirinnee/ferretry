/**
 * The SPEED half of `../../unit/host-config/adversarial-bound.test.ts`: every hostile shape at the size cap answers
 * within one hard bound through every door a text comes in by, and a text far over the cap is refused as fast as one at
 * it. The answers (the last good version stays, the fixed sentence) are held here at the size cap and in unit on small shapes.
 */
import { describe, expect, test } from 'bun:test';
import { findFlagSecrets } from '@ferretry/std/credential-words';
import { CONFIG_FILE_MAX_BYTES, readConfigText } from '@ferretry/std/yaml';
import { checkConfigText } from '../../../host/config/check.ts';
import { shownConfigText } from '../../../host/config/shown-text.ts';
import {
  call,
  ferretStanding,
  mcpWorld,
  prepared,
  UNITS,
  VOICE,
  voiceDef,
  wordShapes,
} from '../../unit/host-config/adversarial-support.ts';
import { adversarialTexts, PRIVATE_WORD, REFUSED_AT_THE_CAP } from '../../unit/host-config/adversarial-texts.ts';
import { openDef } from '../../unit/host-config/masked-support.ts';

/** A hard bound per call, far above one linear pass: the slow shapes this guards took seconds to days at this size. */
const BOUND_MS = 1500;

/**
 * The CPU the main thread spends in `act`, in ms (everything here is in memory, so all of it is on the main thread). A
 * bound on the clock measures the box as much as the code, and a call is hundreds of ms, far above the CPU clock's tick.
 */
async function timed(act: () => Promise<unknown> | unknown): Promise<number> {
  if (typeof process.threadCpuUsage !== 'function') throw new Error('process.threadCpuUsage is not available');
  const before = process.threadCpuUsage();
  await act();
  const spent = process.threadCpuUsage(before);
  return (spent.user + spent.system) / 1_000;
}

/**
 * The CPU clock must read something. Only the !!omap shapes (hundreds of ms a call) can say so: a cheap shape, such as a
 * long comment, costs under the clock's 1 ms tick and reads 0 on a clock that works.
 */
function clockReads(label: string, ms: number): void {
  if (label.includes('!!omap')) expect(ms).toBeGreaterThan(0);
}

/**
 * The BEST of up to three samples: a quadratic path is slow in every sample and fails, a collection or a busy moment on
 * a shared runner lands in one and does not. A further sample is taken only while the best so far fails the bound
 * (re-sampling one cost a fresh world and a reload each, enough to cross bun's 5 s test timeout at 750 ms a call). A
 * later attempt starts from a world of its own, because a check one load made is remembered and a second call on the
 * same world would measure the memo, not the parse.
 */
async function bestOf(sample: (attempt: number) => Promise<number>): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3 && best >= BOUND_MS; attempt += 1) {
    best = Math.min(best, await sample(attempt));
  }
  return best;
}

function timedSync(act: () => void): number {
  const started = performance.now();
  act();
  return performance.now() - started;
}

describe('every hostile shape at the size cap answers within the bound, at every door', () => {
  for (const [label, text] of adversarialTexts(CONFIG_FILE_MAX_BYTES)) {
    test(`T-0033 T-0034 ${label}: validate and write each answer in under ${BOUND_MS} ms`, async () => {
      const first = await prepared();
      let last = first;
      let slowest = 0;
      for (const tool of ['config.validate', 'config.write'] as const) {
        const spent = await bestOf(async attempt => {
          last = attempt === 0 ? first : await prepared();
          return await timed(() => last.agent.run(call({ tool, path: 'voice.yaml', text }), ferretStanding));
        });
        slowest = Math.max(slowest, spent);
        expect(spent).toBeLessThan(BOUND_MS);
      }
      clockReads(label, slowest);
      // Either the text checked and is in effect, or it was refused and the file is as it was.
      const { fs, files } = last;
      const now = await fs.readText(VOICE);
      expect(now === text || now === 'limit: 7\n').toBe(true);
      if (now !== text) expect(files.port('voice').file(voiceDef)?.limit).toBe(7);
    });

    test(`T-0032 ${label}, hand-written: the reload and config_read each answer in under ${BOUND_MS} ms`, async () => {
      const first = await prepared();
      let last = first;
      const reloaded = await bestOf(async attempt => {
        last = attempt === 0 ? first : await prepared();
        last.fs.seed(VOICE, text);
        return await timed(() => last.files.reload());
      });
      clockReads(label, reloaded);
      expect(reloaded).toBeLessThan(BOUND_MS);
      const { files } = last;
      const state = files.status().files.find(file => file.path === 'voice.yaml')?.state;
      if (state !== 'ok') expect(files.port('voice').file(voiceDef)?.limit).toBe(7);
      const read = await bestOf(async attempt => {
        let target = last;
        if (attempt > 0) {
          target = await prepared();
          target.fs.seed(VOICE, text);
          await target.files.reload();
        }
        return await timed(() => target.agent.run(call({ tool: 'config.read', path: 'voice.yaml' }), ferretStanding));
      });
      expect(read).toBeLessThan(BOUND_MS);
    });
  }
});

describe('the shapes whose answer depends on their size are refused at the cap as the unit tier refuses them small', () => {
  const full = new Map(adversarialTexts(CONFIG_FILE_MAX_BYTES));
  for (const [label, { message }] of REFUSED_AT_THE_CAP)
    test(`${label}: read at the cap, the first refusal is "${message}"`, () => {
      const read = readConfigText(full.get(label) ?? '');
      expect(read.ok ? undefined : read.errors[0]?.message).toBe(message);
    });
});

describe('a text over the size cap is refused before anything reads it, as fast as one at it', () => {
  const over = `note: ${PRIVATE_WORD}\n${'#'.repeat(CONFIG_FILE_MAX_BYTES)}`;
  const overInBytes = `note: ${'é'.repeat(CONFIG_FILE_MAX_BYTES / 2)}`;

  test(`the check answers in under ${BOUND_MS} ms, a text sixty-four times the cap included`, () => {
    for (const text of [over, overInBytes, ' '.repeat(64 * CONFIG_FILE_MAX_BYTES)])
      expect(timedSync(() => checkConfigText(voiceDef, 'voice.yaml', text, 'fy'))).toBeLessThan(BOUND_MS);
  });
});

describe('T-A10 the kernel word cutter and the flag rule stay linear on hostile words', () => {
  for (const [label, unit] of UNITS) {
    for (const [shape, text] of wordShapes(unit, CONFIG_FILE_MAX_BYTES)) {
      test(`T-A10 CFG-LEAK-R ${label}, ${shape}: the mask and findFlagSecrets each answer in under ${BOUND_MS} ms`, () => {
        expect(timedSync(() => shownConfigText(openDef, 'open.yaml', text, 'fy'))).toBeLessThan(BOUND_MS);
        const read = readConfigText(text);
        if (read.ok) expect(timedSync(() => findFlagSecrets(read.read.value))).toBeLessThan(BOUND_MS);
      });
    }
  }

  for (const [label, unit] of UNITS)
    test(`T-A10 CFG-LEAK-W ${label}: the write door answers a hostile text at the cap within the bound, and the read door after it`, async () => {
      const agent = await mcpWorld();
      for (const [, text] of wordShapes(unit, CONFIG_FILE_MAX_BYTES)) {
        const write = await timed(() =>
          agent.run(call({ tool: 'config.write', path: 'mcp/srv.yaml', text }), ferretStanding),
        );
        expect(write).toBeLessThan(BOUND_MS);
        const read = await timed(() => agent.run(call({ tool: 'config.read', path: 'mcp/srv.yaml' }), ferretStanding));
        expect(read).toBeLessThan(BOUND_MS);
      }
    });
});
