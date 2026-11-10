/**
 * Every hostile shape a configuration file can take, at the size cap, through every door a text comes in by
 * (`config_validate`, `config_write`, a reload of a hand-written file): each answers within one hard bound, never throws,
 * and keeps the last good version in effect. And a text over the cap is refused before anything reads it, in one fixed
 * sentence. Boot is covered by `../host/config-alias-boot.test.ts` with the same shapes.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { AgentConfigCallSchema, type AgentConfigCall } from '../../../contract/agent-config.ts';
import { defineConfig } from '../../../contract/index.ts';
import { agentConfig } from '../../../host/config/agent.ts';
import { checkConfigText } from '../../../host/config/check.ts';
import { evaluateConfig } from '../../../host/config/evaluate.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { CONFIG_FILE_MAX_BYTES, CONFIG_TOO_LARGE, configTextTooLarge } from '@ferretry/std/yaml';
import type { HostFs } from '../../../host/state/host-fs.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { adversarialTexts, PRIVATE_WORD } from './adversarial-texts.ts';
import { captureLog, HOME, manualClock } from './support.ts';

/** A hard bound per call, far above one linear pass: the slow shapes this guards took seconds to days at this size. */
const BOUND_MS = 1500;
const VOICE = `${HOME}/config/voice.yaml`;

/** A file the agent may name, taking any `note` so a valid hostile text is also put in effect (and read back). */
const voiceDef = defineConfig({
  file: 'voice.yaml',
  schema: z.strictObject({ limit: z.number().int().default(10), note: z.unknown().optional() }),
  axis: 'configure',
  loosens: () => [],
});

const ferretStanding = { credential: { kind: 'authenticated', tokenClass: 'ferret', ferret: 'wren' } };

function world(fs: HostFs & { seed(path: string, data: string): void } = createMemoryHostFs()) {
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [{ plugin: 'voice', def: voiceDef }],
  });
  const agent = agentConfig({
    writer: () => files.writer(),
    control: () => ({ allows: async () => true }),
    status: () => files.status(),
    home: HOME,
    binary: 'fy',
    now: () => '2026-01-01T00:00:00.000Z',
  });
  return { fs, files, agent };
}

const call = (body: Record<string, unknown>): AgentConfigCall => AgentConfigCallSchema.parse(body);

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
 * The BEST of up to three samples (the same shape as `issue-cap.test.ts`): a quadratic path is slow in every sample and
 * fails, a collection or a busy moment on a shared runner lands in one and does not. A further sample is taken only
 * while the best so far is at or over half the bound, so a fast first sample costs nothing more. `sample` is told which
 * attempt it is: a later one starts from a world of its own, because a check one load made is remembered and a second
 * call on the same world would measure the memo, not the parse.
 */
async function bestOf(sample: (attempt: number) => Promise<number>): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 3 && best >= BOUND_MS / 2; attempt += 1) {
    best = Math.min(best, await sample(attempt));
  }
  return best;
}

/** A world holding the last good file, loaded: what every sample starts from. */
async function prepared(): Promise<ReturnType<typeof world>> {
  const fresh = world();
  fresh.fs.seed(VOICE, 'limit: 7\n');
  await fresh.files.reload();
  return fresh;
}

const SHAPES = adversarialTexts(CONFIG_FILE_MAX_BYTES);

describe('the hostile shapes themselves', () => {
  test('each is at most the cap, and there is one of every kind the reviews found', () => {
    for (const [, text] of SHAPES) expect(configTextTooLarge(text)).toBe(false);
    expect(SHAPES.length).toBeGreaterThanOrEqual(40);
  });
});

describe('every hostile shape at the size cap answers within the bound, at every door', () => {
  for (const [label, text] of SHAPES) {
    test(`T-0033 T-0034 ${label}: validate and write each answer in under ${BOUND_MS} ms`, async () => {
      const first = await prepared();
      let last = first;
      for (const tool of ['config.validate', 'config.write'] as const) {
        const spent = await bestOf(async attempt => {
          last = attempt === 0 ? first : await prepared();
          return await timed(() => last.agent.run(call({ tool, path: 'voice.yaml', text }), ferretStanding));
        });
        expect(spent).toBeLessThan(BOUND_MS);
      }
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

describe('a text over the size cap is refused before anything reads it', () => {
  /** Over the cap by one byte, with a word that must never come back. */
  const over = `note: ${PRIVATE_WORD}\n${'#'.repeat(CONFIG_FILE_MAX_BYTES)}`;
  /** Under the cap in UTF-16 units, over it in UTF-8 bytes. */
  const overInBytes = `note: ${'é'.repeat(CONFIG_FILE_MAX_BYTES / 2)}`;

  test('the cap counts UTF-8 bytes, and the edge is exact', () => {
    expect(configTextTooLarge('a'.repeat(CONFIG_FILE_MAX_BYTES))).toBe(false);
    expect(configTextTooLarge('a'.repeat(CONFIG_FILE_MAX_BYTES + 1))).toBe(true);
    expect(overInBytes.length).toBeLessThan(CONFIG_FILE_MAX_BYTES);
    expect(configTextTooLarge(overInBytes)).toBe(true);
    expect(configTextTooLarge('😀'.repeat(CONFIG_FILE_MAX_BYTES / 4))).toBe(false);
    expect(configTextTooLarge(`a${'😀'.repeat(CONFIG_FILE_MAX_BYTES / 4)}`)).toBe(true);
  });

  test('the check answers ONE fixed sentence and nothing of the text, without reading it', () => {
    for (const text of [over, overInBytes, ' '.repeat(64 * CONFIG_FILE_MAX_BYTES)]) {
      let checked: ReturnType<typeof checkConfigText> | undefined;
      expect(
        // A text sixty-four times the cap is answered as fast as one at it: nothing is parsed or scanned.
        timedSync(() => {
          checked = checkConfigText(voiceDef, 'voice.yaml', text, 'fy');
        }),
      ).toBeLessThan(BOUND_MS);
      expect(checked).toEqual({
        ok: false,
        reason: 'yaml',
        issues: [{ path: 'voice.yaml', severity: 'error', message: CONFIG_TOO_LARGE, fix: 'make the file smaller' }],
      });
      expect(JSON.stringify(checked)).not.toContain(PRIVATE_WORD);
    }
  });

  test('T-0033 T-0034 validate and write refuse it in the fixed sentence, and nothing is written', async () => {
    const { agent, fs, files } = world();
    fs.seed(VOICE, 'limit: 7\n');
    await files.reload();
    // Past the body schema (which refuses it first on the wire): the door itself refuses it too.
    for (const tool of ['config.validate', 'config.write'] as const) {
      const answer = await agent.act({ tool, path: 'voice.yaml', text: over } as AgentConfigCall);
      expect(answer.issues).toEqual([
        { path: 'voice.yaml', severity: 'error', message: CONFIG_TOO_LARGE, fix: 'make the file smaller' },
      ]);
      expect(JSON.stringify(answer)).not.toContain(PRIVATE_WORD);
    }
    expect(await fs.readText(VOICE)).toBe('limit: 7\n');
    expect(files.port('voice').file(voiceDef)?.limit).toBe(7);
  });

  test('T-0032 a hand-written file over the cap: the reload keeps the last good version, config_read shows no text', async () => {
    const { agent, fs, files } = world();
    fs.seed(VOICE, 'limit: 7\n');
    await files.reload();
    fs.seed(VOICE, over);
    await files.reload();
    expect(files.port('voice').file(voiceDef)?.limit).toBe(7);
    expect(files.status().files.find(file => file.path === 'voice.yaml')?.state).toBe('invalid');
    const read = await agent.run(call({ tool: 'config.read', path: 'voice.yaml' }), ferretStanding);
    expect(JSON.stringify(read)).not.toContain(PRIVATE_WORD);
    expect(JSON.stringify(files.status())).not.toContain(PRIVATE_WORD);
  });

  test('T-0032 a file that grew past the cap after its size was read is still not read', async () => {
    const memory = createMemoryHostFs();
    // The size the daemon reads first says the file is small; the text it then reads is not.
    const lying = {
      ...memory,
      info: async (path: string) => {
        const info = await memory.info(path);
        return info === undefined ? undefined : { ...info, size: 1 };
      },
    };
    const { fs, files } = world(lying);
    fs.seed(VOICE, 'limit: 7\n');
    await files.reload();
    fs.seed(VOICE, over);
    await files.reload();
    expect(files.port('voice').file(voiceDef)?.limit).toBe(7);
    expect(JSON.stringify(files.status())).not.toContain(PRIVATE_WORD);
  });

  test('an accepted record over the cap is no last good version: it is never parsed', () => {
    const evaluated = evaluateConfig({
      def: voiceDef,
      path: 'voice.yaml',
      disk: { kind: 'text', text: over },
      accepted: { etag: 'e', text: over },
      digest: text => String(text.length),
      binary: 'fy',
    });
    expect(evaluated.state).toBe('invalid');
    expect(evaluated.inEffect).toBeUndefined();
    expect(evaluated.issues.map(issue => issue.message)).toEqual([CONFIG_TOO_LARGE]);
  });
});

function timedSync(act: () => void): number {
  const started = performance.now();
  act();
  return performance.now() - started;
}
