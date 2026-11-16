/**
 * A file whose YAML aliases cannot be read — an alias to an anchor that is not set, or an alias inside its own anchor —
 * is a broken file like any other (docs/config-files.md, "Last good wins"): it is refused with a located issue, its last
 * good version stays in effect, boot continues and a reload never throws. No issue or log line names the alias.
 * The SPEED of reading such a file at the size limit is `tests/perf/host/config-alias-boot.test.ts`'s.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { CONFIG_FILE_MAX_BYTES } from '@ferretry/std/yaml';
import { adversarialTexts, PRIVATE_WORD } from '../host-config/adversarial-texts.ts';
import { aliasesAt, boot, bootOnce, cleanup, FAKE_NAME, home, namesNothing, writeVoice } from './config-alias-world.ts';

/** Fake only: an alias name shaped like a key. */
const KEY_NAME = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const UNRESOLVED = `limit: 3\nnote: *${FAKE_NAME}\n`;
const LOOP = `limit: 3\nnote: &${FAKE_NAME}\n  again: *${FAKE_NAME}\n`;
/**
 * Billion laughs: each anchor nine of the one before. The third (line 4) reads out past the budget: a value weighs its
 * length, so nine copies of the name nine times over is already some 20 000 characters.
 */
const BOMB = `limit: 3\n${Array.from(
  { length: 10 },
  (_, level) =>
    `l${level}: &l${level} [${Array.from({ length: 9 }, () => (level === 0 ? FAKE_NAME : `*l${level - 1}`)).join(', ')}]\n`,
).join('')}`;

afterEach(cleanup);

describe('an alias that cannot be read is a broken file, not a crash', () => {
  for (const [label, text, message, line] of [
    ['an unresolved alias', UNRESOLVED, 'names an anchor (&name) that is not set before it', 2],
    ['an alias loop', LOOP, 'sits inside the anchor (&name) it names', 3],
    ['an alias bomb', BOMB, 'expand too far to read', 4],
  ] as const) {
    test(`${label} at boot: boot continues and the last good version stays in effect`, async () => {
      const at = await home();
      await bootOnce(at, async first => {
        await writeVoice(at, 'limit: 7\n');
        await first.reload();
        expect(first.limit()).toBe(7);
      });

      await writeVoice(at, text);
      const world = await boot(at);
      expect(world.limit()).toBe(7);
      expect(world.voiceState()).toBe('invalid');
      const [issue] = world.voiceIssues();
      expect(issue?.message).toContain(message);
      expect(issue?.line).toBe(line);
      namesNothing(world);
    });

    test(`${label} at boot with no last good version: boot continues with nothing of the file in effect`, async () => {
      const at = await home();
      await bootOnce(at, async () => {});
      await writeVoice(at, text);
      const world = await boot(at);
      expect(world.voiceState()).toBe('invalid');
      // Nothing was ever accepted, so nothing of the file is in effect: the plugin reads no value and keeps its defaults.
      expect(world.limit()).toBeUndefined();
      namesNothing(world);
    });

    test(`${label} on reload: the reload resolves, the last good version stays, and a fix applies`, async () => {
      const world = await boot(await home());
      const at = world.home;
      await writeVoice(at, 'limit: 7\n');
      await world.reload();
      expect(world.limit()).toBe(7);

      await writeVoice(at, text);
      await world.reload();
      expect(world.limit()).toBe(7);
      expect(world.voiceState()).toBe('invalid');
      expect(world.voiceIssues()[0]?.message).toContain(message);
      namesNothing(world);

      await writeVoice(at, 'limit: 4\n');
      await world.reload();
      expect(world.limit()).toBe(4);
      expect(world.voiceIssues()).toEqual([]);
    });
  }
});

describe('a file of aliases, the last unresolved, is read in one pass at boot and on reload', () => {
  test('a small file of aliases, the last unresolved: boot and the reload each refuse it and keep the last good version', async () => {
    const at = await home();
    await bootOnce(at, async first => {
      await writeVoice(at, 'limit: 7\n');
      await first.reload();
    });
    await writeVoice(at, aliasesAt(4096));

    const world = await boot(at);
    expect(world.limit()).toBe(7);
    expect(world.voiceIssues()[0]?.message).toContain('not set before it');

    await world.reload();
    expect(world.limit()).toBe(7);
    namesNothing(world);
  });
});

describe('every hostile shape, small: boot never fails', () => {
  for (const [label, text] of adversarialTexts(8192)) {
    test(`${label}: boot answers, and the last good version stays unless the file checks`, async () => {
      const at = await home();
      await bootOnce(at, async first => {
        await writeVoice(at, 'limit: 7\n');
        await first.reload();
      });
      await writeVoice(at, text);

      const world = await boot(at);
      if (world.voiceState() !== 'ok') expect(world.limit()).toBe(7);
      namesNothing(world, PRIVATE_WORD);
    });
  }

  test('a file over the cap at boot is not read: boot continues and the last good version stays', async () => {
    const at = await home();
    await bootOnce(at, async first => {
      await writeVoice(at, 'limit: 7\n');
      await first.reload();
    });
    await writeVoice(at, `note: ${PRIVATE_WORD}\n${'#'.repeat(CONFIG_FILE_MAX_BYTES)}`);

    const world = await boot(at);
    expect(world.limit()).toBe(7);
    expect(world.voiceState()).toBe('invalid');
    namesNothing(world, PRIVATE_WORD);
  });
});

describe('an unreadable alias whose name looks like a key', () => {
  test('is refused as a raw secret by its line alone, before anything is said about the alias (R5)', async () => {
    const world = await boot(await home());
    await writeVoice(world.home, 'limit: 7\n');
    await world.reload();

    await writeVoice(world.home, `limit: 3\nnote: *${KEY_NAME}\n`);
    await world.reload();
    expect(world.limit()).toBe(7);
    expect(world.voiceIssues()).toMatchObject([{ line: 2, column: 1, message: expect.stringContaining('raw secret') }]);
    namesNothing(world, KEY_NAME);
  });
});
