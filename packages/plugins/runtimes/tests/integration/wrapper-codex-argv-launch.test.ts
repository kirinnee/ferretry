/**
 * What the Codex kit's launch line adds beyond a launch's own arguments (default model, trusted folder, developer
 * instructions), RUN in `sh` against a stub that prints its argv (E-276 PR 9). `wrapper-codex-argv.test.ts` stays unchanged.
 */
import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderRuntimeWrapperScript } from '../../daemon/lib/wrappers.ts';
import { REAL_KITS } from '../support/real-kits.ts';

const FLAGS = ['--keep-a', '--keep-b'];

/** Runs the wrapper text with a stub `codex` that prints one argument per line; `mode` is the session mode. */
const argvOf = (
  mode: 'interactive' | 'auto',
  launch: { readonly flags?: readonly string[]; readonly defaultModel?: string; readonly trust?: boolean } = {},
): string[] => {
  const flags = launch.flags ?? FLAGS;
  const directory = mkdtempSync(join(tmpdir(), 'fy-codex-argv-'));
  try {
    const stub = join(directory, 'codex');
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@"\n`);
    chmodSync(stub, 0o755);
    const script = renderRuntimeWrapperScript({
      name: 'codex-argv',
      id: '00000000-0000-4000-8000-0000000000c1',
      harness: 'codex',
      kit: REAL_KITS.get('codex'),
      configDirectory: join(directory, 'home'),
      env: {},
      args: flags,
      ...(launch.defaultModel === undefined ? {} : { defaultModel: launch.defaultModel }),
      autonomous: { args: flags, seedFirstRun: false, trustLaunchFolder: launch.trust ?? false },
      fyCommand: 'fy',
      harnessCommand: stub,
    });
    const wrapper = join(directory, 'wrapper');
    writeFileSync(wrapper, script);
    const { stdout } = Bun.spawnSync(['sh', wrapper, 'tail-word'], {
      env: { PATH: '/usr/bin:/bin', HOME: directory, FY_SESSION_MODE: mode },
    });
    return stdout.toString().trimEnd().split('\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe('the Codex launch line, run for real', () => {
  it('should start the default model with a -c override ahead of the flags, in both modes', () => {
    expect(argvOf('interactive', { defaultModel: 'gpt-6' })).toEqual([
      '-c',
      'model="gpt-6"',
      '--keep-a',
      '--keep-b',
      'tail-word',
    ]);
  });

  it('should trust the physical launch folder in an auto launch, after the flags and the question override', () => {
    const argv = argvOf('auto', { trust: true });
    expect(argv.slice(0, 4)).toEqual(['--keep-a', '--keep-b', '-c', 'features.default_mode_request_user_input=false']);
    expect(argv.slice(4)).toEqual([
      '-c',
      expect.stringMatching(/^projects=\{".*"=\{trust_level="trusted"\}\}$/u),
      'tail-word',
    ]);
  });

  it('should append the sections inside the closing quote of developer_instructions, escaped as a TOML string', () => {
    const argv = argvOf('auto', { flags: ['developer_instructions="base"'] });
    const instructions = argv[0] as string;
    expect(instructions.startsWith('developer_instructions="base')).toBe(true);
    expect(instructions.endsWith('"')).toBe(true);
    expect(instructions).toContain('\\u000a');
  });
});
