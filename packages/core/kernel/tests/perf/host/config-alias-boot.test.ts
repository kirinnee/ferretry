/**
 * The SPEED half of `../../unit/host/config-alias-boot.test.ts`: a configuration file full of YAML aliases at the size
 * limit, and every hostile shape at the size cap, is read at boot (and a reload) within one hard bound. The answers
 * (the refusal, the last good version, no alias name said) are unit's.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { AGENT_CONFIG_TEXT_MAX_BYTES } from '../../../contract/agent-config.ts';
import { CONFIG_FILE_MAX_BYTES } from '@ferretry/std/yaml';
import { adversarialTexts, PRIVATE_WORD } from '../../unit/host-config/adversarial-texts.ts';
import {
  aliasesAt,
  boot,
  bootOnce,
  cleanup,
  home,
  namesNothing,
  writeVoice,
} from '../../unit/host/config-alias-world.ts';

/** A hard bound, far above one linear read; the quadratic read this guards took minutes on a file this size. */
const BOUND_MS = 1500;

afterEach(cleanup);

describe('a file at the size limit is read in one pass at boot and on reload', () => {
  test('a 256 KiB file of aliases, the last unresolved: boot and the reload each read it in under the bound', async () => {
    const at = await home();
    await bootOnce(at, async first => {
      await writeVoice(at, 'limit: 7\n');
      await first.reload();
    });
    // A file at the agent door's size limit, every line an alias, the last one unresolved.
    await writeVoice(at, aliasesAt(AGENT_CONFIG_TEXT_MAX_BYTES));

    const booting = performance.now();
    const world = await boot(at);
    // Boot does more than read one file; the read itself is what the bound is about, so it is given the bound twice.
    expect(performance.now() - booting).toBeLessThan(BOUND_MS * 2);
    expect(world.limit()).toBe(7);
    expect(world.voiceIssues()[0]?.message).toContain('not set before it');

    const reloading = performance.now();
    await world.reload();
    expect(performance.now() - reloading).toBeLessThan(BOUND_MS);
    expect(world.limit()).toBe(7);
    namesNothing(world);
  });
});

describe('every hostile shape at the size cap: boot reads it within the bound and never fails', () => {
  for (const [label, text] of adversarialTexts(CONFIG_FILE_MAX_BYTES)) {
    test(`${label}: boot answers in under ${BOUND_MS} ms, and the last good version stays unless the file checks`, async () => {
      const at = await home();
      await bootOnce(at, async first => {
        await writeVoice(at, 'limit: 7\n');
        await first.reload();
      });
      await writeVoice(at, text);

      const booting = performance.now();
      const world = await boot(at);
      expect(performance.now() - booting).toBeLessThan(BOUND_MS);
      if (world.voiceState() !== 'ok') expect(world.limit()).toBe(7);
      namesNothing(world, PRIVATE_WORD);
    });
  }
});
