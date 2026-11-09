/**
 * BG-005 through Runtimes' seam: a rename is a set that REMOVES the old runtime's file and WRITES the new one. Over the
 * REAL kernel config service (on a memory filesystem; the testing host does not model bytes), an old file that is not
 * UTF-8 refuses the whole set, in the kernel's sentence naming that file, and neither the old file nor the new one is
 * touched: a roll-back of a set would otherwise put the old file back with U+FFFD over the owner's bytes.
 */
import { describe, it } from 'bun:test';
import { config as kernelConfig, state as kernelState } from '@ferretry/kernel/host';
import should from 'should';
import { PROFILE_ITEMS, RUNTIME_ITEMS } from '../../../contract/index.ts';
import { writeAllConfigWriter } from '../../../daemon/adapters/config-write-all.ts';
import { ConfigWriteInvalid } from '../../../daemon/lib/service/ports.ts';

const HOME = '/home/fy';
const CONFIG = `${HOME}/config`;
const OLD = `${CONFIG}/runtimes/old.yaml`;
const NEW = `${CONFIG}/runtimes/new.yaml`;

const LATIN1_RUNTIME = new Uint8Array([
  ...new TextEncoder().encode('# caf'),
  0xe9,
  ...new TextEncoder().encode('\nlogin: claude-you\nprofile: p\n'),
]);

async function realWorld() {
  const fs = kernelState.createMemoryHostFs();
  const cancel = () => undefined;
  const config = kernelConfig.createConfigFiles({
    home: HOME,
    fs,
    clock: { nowMs: () => 0, after: () => cancel, every: () => cancel },
    log: { debug() {}, info() {}, warn() {}, error() {}, child: () => undefined } as never,
    binary: 'fy',
    defs: [
      { plugin: 'runtimes', def: PROFILE_ITEMS as never },
      { plugin: 'runtimes', def: RUNTIME_ITEMS as never },
    ],
  });
  fs.seed(OLD, LATIN1_RUNTIME);
  fs.seed(`${CONFIG}/profiles/p.yaml`, 'contents: []\n');
  await config.reload();
  return { fs, writer: writeAllConfigWriter(config.port('runtimes'), CONFIG) };
}

describe('BG-005 a rename over a runtime file that is not UTF-8 (Runtimes’ remove + write set)', () => {
  it('BG-005 should refuse the whole set in the sentence that names the old file, writing nothing', async () => {
    // Arrange
    const { fs, writer } = await realWorld();
    const before = fs.snapshot().get(OLD);

    // Act
    const act = writer.write([
      { path: NEW, content: 'login: claude-you\nprofile: p\n', mode: 0o600 },
      { path: OLD, content: '', mode: 0o600, remove: true },
    ]);

    // Assert — the owner is told which file and why; the old bytes are exactly as they were; the new file is absent.
    await should(act).be.rejectedWith(ConfigWriteInvalid);
    await act.catch((error: unknown) => {
      should(String(error instanceof Error ? error.message : error)).containEql(
        'runtimes/old.yaml is not UTF-8: saving would change bytes you did not edit; nothing was written',
      );
    });
    should(fs.snapshot().get(OLD)).equal(before);
    should(fs.snapshot().has(NEW)).be.false();
  });
});
