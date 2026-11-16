/**
 * The terminal environment is owner-only, proved on the kernel's real config service (not only on the pure judgement):
 * the real Terminals def on the real `createConfigFiles`. An agent's write is held, and a hand edit on disk is pending.
 */
import { describe, expect, it } from 'bun:test';
import type { ConfigFileDef, Log } from '@ferretry/kernel/contract';
import { config, state } from '@ferretry/kernel/host';
import { fixedClock } from '@ferretry/kernel/testing';
import type { TerminalsConfig } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';

const HOME = '/home/fy';
const PATH = `${HOME}/config/terminals.yaml`;
const [DEF] = manifest.data.config as [ConfigFileDef];

const quiet: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
} as unknown as Log;

/** `atBoot` is a file already on disk when the daemon first reads the folder (no accepted record for it). */
async function service(judge: () => boolean, atBoot?: string) {
  const fs = state.createMemoryHostFs();
  if (atBoot !== undefined) fs.seed(PATH, atBoot);
  const files = config.createConfigFiles({
    home: HOME,
    fs,
    clock: fixedClock('2026-11-09T09:00:00.000Z'),
    log: quiet,
    binary: 'fy',
    defs: [{ plugin: 'terminals', def: DEF }],
    judge,
  });
  await files.reload();
  const port = files.port('terminals');
  const environment = () => (port.file(DEF) as TerminalsConfig | undefined)?.environment;
  return { fs, files, port, environment };
}

describe('the terminal environment: owner-only on the real config service', () => {
  it('holds an agent write: the environment stays as it was, and the sentence names the variable', async () => {
    // Gate's verdict for a ferret's write of a loosening is "hold" (the kernel's judge returns false).
    const { port, environment } = await service(() => false);

    const result = await port.write(DEF, undefined, 'environment:\n  BASH_ENV: /tmp/x\n');

    expect(result.kind).toBe('held');
    expect(environment()).toBeUndefined();
    expect(JSON.stringify(result)).toContain('every terminal will open with BASH_ENV set');
  });

  it('puts the same write into effect once the owner has applied it', async () => {
    const { port, environment } = await service(() => true);

    const result = await port.write(DEF, undefined, 'environment:\n  A: "1"\n');

    expect(result.kind).toBe('written');
    expect(environment()).toEqual({ A: '1' });
  });

  it('leaves a hand edit on disk pending when nothing was accepted: no environment is in effect', async () => {
    const { port, environment } = await service(() => true, 'environment:\n  BASH_ENV: /tmp/x\n');

    const standing = port.fileState(DEF);
    // The kernel's evaluate calls this `pending`; the config port reports it as `held`.
    expect(standing.state).toBe('held');
    expect(JSON.stringify(standing)).toContain('every terminal will open with BASH_ENV set');
    expect(environment()).toBeUndefined();
  });

  it('holds a hand edit on disk beside an accepted file: the old environment stays in effect', async () => {
    const { fs, files, port, environment } = await service(() => true);
    expect((await port.write(DEF, undefined, 'environment:\n  A: "1"\n')).kind).toBe('written');

    fs.seed(PATH, 'environment:\n  A: "1"\n  BASH_ENV: /tmp/x\n');
    await files.reload();

    const standing = port.fileState(DEF);
    expect(standing.state).toBe('held');
    expect(JSON.stringify(standing)).toContain('every terminal will open with BASH_ENV set');
    expect(environment()).toEqual({ A: '1' });
  });

  it('keeps the last good environment when a later edit is invalid', async () => {
    const { fs, files, port, environment } = await service(() => true);
    expect((await port.write(DEF, undefined, 'environment:\n  A: "1"\n')).kind).toBe('written');

    fs.seed(PATH, 'environment:\n  PATH: /evil\n');
    await files.reload();

    expect(port.fileState(DEF).state).toBe('invalid');
    expect(environment()).toEqual({ A: '1' });
  });
});
