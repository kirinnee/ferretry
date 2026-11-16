import { describe, expect, test } from 'bun:test';
import { createConfigFiles } from '../../../kernel/host/config/service.ts';
import { createMemoryHostFs } from '../../../kernel/host/state/memory-fs.ts';
import { DEFAULT_GATE_CONFIG, GateConfigFile } from '../../contract/index.ts';
import { GateConfigWriter } from '../../daemon/adapters/config/gate-config-writer.ts';

/**
 * G131 a disk edit of `config/gate.yaml` is always held. Gate's own writer saves one top-level key with
 * `confirmedLoosening`, so it must be made to BOTH versions of the file: the owner's save of one key never confirms an
 * edit a hand (a ferret's shell) left held on the disk.
 */
const HOME = '/home/fy';
const PATH = `${HOME}/config/gate.yaml`;

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const clock = { nowMs: () => 1_000_000, after: () => () => {}, every: () => () => {} };

async function gateFiles() {
  const fs = createMemoryHostFs();
  const files = createConfigFiles({
    home: HOME,
    fs,
    clock,
    log: silent as never,
    binary: 'fy',
    defs: [{ plugin: 'gate', def: GateConfigFile as never }],
    judge: () => false,
  });
  await files.reload();
  const writer = new GateConfigWriter(() => files.writer(), { plugin: 'gate', def: GateConfigFile } as never);
  // The owner's first grant save creates the file; nothing is held.
  await writer.write('grants', DEFAULT_GATE_CONFIG.grants);
  const port = files.port('gate');
  const inEffect = () =>
    port.file(GateConfigFile as never) as {
      warden: { remote: boolean };
      grants: { terminal: { use: boolean; configure: boolean } };
    };
  return { fs, files, writer, inEffect };
}

describe('G131 a hand edit of gate.yaml stays held when the owner saves another key', () => {
  test('G131 a hand edit turning on a remote warden is held, and the owner narrowing a grant does not put it into effect', async () => {
    const { fs, files, writer, inEffect } = await gateFiles();
    expect(inEffect().warden.remote).toBe(false);
    // A local process edits the file on disk: a loosening, so the load holds it.
    await fs.writeAtomic(PATH, 'warden:\n  remote: true\n', 0o600);
    await files.reload();
    expect(files.held().map(edit => edit.sentences)).toEqual([['a remote warden is now honoured']]);
    // The owner narrows a grant from the app: Gate's route already decided THIS change may be made.
    await writer.write('grants', { ...DEFAULT_GATE_CONFIG.grants, terminal: { use: false, configure: false } });
    expect(inEffect().warden.remote).toBe(false);
    expect(files.held().length).toBe(1);
  });

  test('G131 a hand edit widening a grant is held, and the owner saving the security settings does not put it into effect', async () => {
    const { fs, files, writer, inEffect } = await gateFiles();
    // The owner narrows the terminal grant: in effect, nothing held.
    await writer.write('grants', { ...DEFAULT_GATE_CONFIG.grants, terminal: { use: false, configure: false } });
    expect(inEffect().grants.terminal).toEqual({ use: false, configure: false });
    // A local process turns it back on by hand: a widening, so the load holds it.
    await fs.writeAtomic(PATH, 'grants:\n  terminal:\n    use: true\n    configure: true\n', 0o600);
    await files.reload();
    expect(files.held().length).toBe(1);
    await writer.write('security', DEFAULT_GATE_CONFIG.security);
    expect(inEffect().grants.terminal).toEqual({ use: false, configure: false });
    expect(files.held().length).toBe(1);
  });
});
