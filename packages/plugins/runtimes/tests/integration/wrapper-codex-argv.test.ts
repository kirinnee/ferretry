/**
 * What a Codex launch really passes to the harness, RUN in `sh` against a stub that prints its argv. Claude's question-tool
 * flag is dropped from every launch's own arguments, Codex's included: a Codex settings component can carry it, and the base
 * never handed it to Codex (E-276 PR 8, review r1 MUST 1).
 */
import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_NO_QUESTIONS_FLAG } from '../../daemon/lib/account/fixed-layer.ts';
import { renderRuntimeWrapperScript } from '../../daemon/lib/wrappers.ts';
import { REAL_KITS } from '../support/real-kits.ts';

const FLAGS = ['--keep-a', CLAUDE_NO_QUESTIONS_FLAG, '--keep-b'];

/** Runs the wrapper text with a stub `codex` that prints one argument per line; `mode` is the session mode. */
const argvOf = (mode: 'interactive' | 'auto'): string[] => {
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
      args: FLAGS,
      autonomous: { args: FLAGS, seedFirstRun: false, trustLaunchFolder: false },
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

describe('the Codex launch argv, run for real', () => {
  it('should never hand Codex the question-tool flag a Codex settings component carried, interactive', () => {
    expect(argvOf('interactive')).toEqual(['--keep-a', '--keep-b', 'tail-word']);
  });

  it('should never hand Codex the question-tool flag a Codex settings component carried, auto', () => {
    expect(argvOf('auto')).toEqual([
      '--keep-a',
      '--keep-b',
      '-c',
      'features.default_mode_request_user_input=false',
      'tail-word',
    ]);
  });
});
