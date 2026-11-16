/**
 * Every hostile shape a configuration file can take, through every door a text comes in by (`config_validate`,
 * `config_write`, a reload of a hand-written file): each answers, never throws, and keeps the last good version in
 * effect. And a text over the cap is refused before anything reads it, in one fixed sentence. Boot is covered by
 * `../host/config-alias-boot.test.ts` with the same shapes. The shapes here are small: the answers are the same at any
 * size, and the bound at the size cap is `tests/perf/host-config/adversarial-bound.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import type { AgentConfigCall } from '../../../contract/agent-config.ts';
import { checkConfigText } from '../../../host/config/check.ts';
import { evaluateConfig } from '../../../host/config/evaluate.ts';
import { findFlagSecrets } from '@ferretry/std/credential-words';
import { shownConfigText } from '../../../host/config/shown-text.ts';
import { CONFIG_FILE_MAX_BYTES, CONFIG_TOO_LARGE, configTextTooLarge, readConfigText } from '@ferretry/std/yaml';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import {
  call,
  ferretStanding,
  mcpWorld,
  prepared,
  UNITS,
  VOICE,
  voiceDef,
  wordShapes,
  world,
} from './adversarial-support.ts';
import { adversarialTexts, PRIVATE_WORD } from './adversarial-texts.ts';
import { openDef } from './masked-support.ts';

/** The size the shapes are built to here: small, so time is irrelevant. */
const SMALL = 8 * 1024;

describe('the hostile shapes themselves', () => {
  test('each is at most the cap, and there is one of every kind the reviews found', () => {
    const shapes = adversarialTexts(CONFIG_FILE_MAX_BYTES);
    for (const [, text] of shapes) expect(configTextTooLarge(text)).toBe(false);
    expect(shapes.length).toBeGreaterThanOrEqual(40);
  });
});

describe('every hostile shape answers, at every door', () => {
  for (const [label, text] of adversarialTexts(SMALL)) {
    test(`T-0033 T-0034 ${label}: validate and write each answer, and the file is in effect or as it was`, async () => {
      const { fs, files, agent } = await prepared();
      for (const tool of ['config.validate', 'config.write'] as const)
        await agent.run(call({ tool, path: 'voice.yaml', text }), ferretStanding);
      // Either the text checked and is in effect, or it was refused and the file is as it was.
      const now = await fs.readText(VOICE);
      expect(now === text || now === 'limit: 7\n').toBe(true);
      if (now !== text) expect(files.port('voice').file(voiceDef)?.limit).toBe(7);
    });

    test(`T-0032 ${label}, hand-written: the reload and config_read each answer`, async () => {
      const { fs, files, agent } = await prepared();
      fs.seed(VOICE, text);
      await files.reload();
      const state = files.status().files.find(file => file.path === 'voice.yaml')?.state;
      if (state !== 'ok') expect(files.port('voice').file(voiceDef)?.limit).toBe(7);
      expect(await agent.run(call({ tool: 'config.read', path: 'voice.yaml' }), ferretStanding)).toBeDefined();
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
      // A text sixty-four times the cap is refused like one at it: nothing is parsed or scanned (the cost is perf's).
      const checked = checkConfigText(voiceDef, 'voice.yaml', text, 'fy');
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

describe('T-A10 the kernel word cutter and the flag rule answer on hostile words', () => {
  for (const [label, unit] of UNITS) {
    for (const [shape, text] of wordShapes(unit, SMALL)) {
      test(`T-A10 CFG-LEAK-R ${label}, ${shape}: the mask and findFlagSecrets each answer`, () => {
        expect(configTextTooLarge(text)).toBe(false);
        expect(shownConfigText(openDef, 'open.yaml', text, 'fy')).toBeDefined();
        const read = readConfigText(text);
        if (read.ok) expect(findFlagSecrets(read.read.value)).toBeDefined();
      });
    }
  }

  for (const [label, unit] of UNITS)
    test(`T-A10 CFG-LEAK-W ${label}: the write door answers a hostile text, and the read door after it`, async () => {
      const agent = await mcpWorld();
      for (const [, text] of wordShapes(unit, SMALL)) {
        expect(
          await agent.run(call({ tool: 'config.write', path: 'mcp/srv.yaml', text }), ferretStanding),
        ).toBeDefined();
        expect(await agent.run(call({ tool: 'config.read', path: 'mcp/srv.yaml' }), ferretStanding)).toBeDefined();
      }
    });
});
