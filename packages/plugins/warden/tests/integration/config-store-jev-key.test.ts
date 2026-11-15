/**
 * c58-22: whether `warden.yaml` names the Jev key, and the caller's act of naming it, through the kernel's real config
 * writer. Naming is a new `${secret:JEV_API_KEY}` reference, which only the owner may add: a write made outside the
 * owner's own call (a job, an agent) is HELD, so nothing is in effect until the owner confirms it, and the answer is the
 * sentence that says so. The reference is the only thing written and no value is ever read.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { Log } from '@ferretry/kernel/contract';
import { config, state } from '@ferretry/kernel/host';
import { fixedClock } from '@ferretry/kernel/testing';
import { WARDEN_CONFIG, WARDEN_JEV_KEY_REFERENCE } from '../../contract/index.ts';
import { ConfigWardenConfigStore } from '../../daemon/adapters/config-store.ts';

const HOME = '/home/fy';
const PATH = `${HOME}/config/warden.yaml`;

const quiet: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
} as unknown as Log;

async function world() {
  const fs = state.createMemoryHostFs();
  const files = config.createConfigFiles({
    home: HOME,
    fs,
    clock: fixedClock('2026-11-08T09:00:00.000Z'),
    log: quiet,
    binary: 'fy',
    defs: [{ plugin: 'warden', def: WARDEN_CONFIG }],
    judge: () => false,
  });
  await files.reload();
  return { fs, files, store: new ConfigWardenConfigStore(files.port('warden')) };
}

describe('the Jev key reference in warden.yaml, through the real kernel writer', () => {
  it('should say it is not named, and hold the naming for the owner when the call is not the owner’s own', async () => {
    const { fs, store } = await world();
    should(store.jevKeyNamed()).equal(false);

    const waiting = await store.nameJevKey();

    should(waiting).eql(['names the secret JEV_API_KEY, which only the owner may add to a configuration']);
    should(store.jevKeyNamed()).equal(false);
    // what waits on disk is the one reference: no value and no other line
    should(String(fs.snapshot().get(PATH) ?? '')).not.match(/sk-|bearer/iu);
  });

  it('should say it is named once the owner has confirmed the reference', async () => {
    const { fs, files, store } = await world();
    fs.seed(PATH, `jev:\n  key: ${WARDEN_JEV_KEY_REFERENCE}\n`);
    await files.reload();
    should(store.jevKeyNamed()).equal(false);

    for (const edit of files.held()) should(await files.confirm(edit.id)).equal(true);

    should(store.jevKeyNamed()).equal(true);
  });
});
