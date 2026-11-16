import { describe, expect, test } from 'bun:test';
import {
  claudeSessionArguments,
  codexCorrelationArguments,
  handoffReadArguments,
  harnessHomeFromWrapper,
  isCodexCorrelationPair,
  relaunchCommand,
  transcriptLaunchArguments,
} from '../../../../daemon/lib/session/peers/transcript-launch.ts';

describe('the launch arguments a harness is given', () => {
  test('claude may read the folders a handover brief points into, and codex needs nothing', () => {
    expect(handoffReadArguments('claude', ['work/a', 'work/b'])).toEqual([
      '--allowedTools=Read(/work/a/**)',
      '--allowedTools=Read(/work/b/**)',
    ]);
    expect(handoffReadArguments('codex', ['work/a'])).toEqual([]);
  });

  test('claude writes the transcript this daemon named', () => {
    expect(claudeSessionArguments('abc-123')).toEqual(['--session-id', 'abc-123']);
  });

  test('a codex rollout carries the correlation token because it is declared under an unreachable root', () => {
    const [flag, value] = codexCorrelationArguments('tok-1');
    expect([flag, value]).toEqual(['--add-dir', 'tok-1/codex-correlation/unreachable']);
    expect(isCodexCorrelationPair(flag as string, value)).toBe(true);
  });

  test('only that flag and that value shape is the correlation pair', () => {
    expect(isCodexCorrelationPair('--add-dir', '/work/project')).toBe(false);
    expect(isCodexCorrelationPair('--cd', 'tok/codex-correlation/unreachable')).toBe(false);
    expect(isCodexCorrelationPair('--add-dir', undefined)).toBe(false);
  });
});

describe('relaunching a harness', () => {
  const command = ['/wrapper/claude', '--session-id', 'abc', '--model', 'opus'];

  test('resumes the session when it was created, leaving the wrapper in place', () => {
    expect(relaunchCommand(command, true)).toEqual(['/wrapper/claude', '--resume', 'abc', '--model', 'opus']);
    expect(command[1]).toBe('--session-id');
  });

  test('keeps the argv unchanged when the session was never created', () => {
    expect(relaunchCommand(command, false)).toBe(command);
  });

  test('keeps the argv unchanged when it carries no session flag, or the flag is where the wrapper is', () => {
    const codex = ['/wrapper/codex', '--model', 'x'];
    expect(relaunchCommand(codex, true)).toBe(codex);
    const odd = ['--session-id', 'abc'];
    expect(relaunchCommand(odd, true)).toBe(odd);
  });
});

describe('the harness home a wrapper script declares', () => {
  const env = { HOME: '/home/fy', ROOT: '/srv', EMPTY: '' };

  test('reads the three forms a generated wrapper writes', () => {
    expect(harnessHomeFromWrapper('export CLAUDE_CONFIG_DIR=/a/b # note', 'claude', env)).toBe('/a/b');
    expect(harnessHomeFromWrapper('  CLAUDE_CONFIG_DIR="/with space/b"', 'claude', env)).toBe('/with space/b');
    expect(harnessHomeFromWrapper("export CODEX_HOME='/c/d'", 'codex', env)).toBe('/c/d');
  });

  test('reads the variable of the harness asked about and no other', () => {
    expect(harnessHomeFromWrapper('export CODEX_HOME=/c/d', 'claude', env)).toBeUndefined();
    expect(harnessHomeFromWrapper('echo hello', 'codex', env)).toBeUndefined();
  });

  test('is nothing when the declared value is empty', () => {
    expect(harnessHomeFromWrapper('export CODEX_HOME=""', 'codex', env)).toBeUndefined();
  });

  test('expands a leading tilde and both spellings of a variable reference', () => {
    expect(harnessHomeFromWrapper('export CODEX_HOME=~/.codex-x', 'codex', env)).toBe('/home/fy/.codex-x');
    expect(harnessHomeFromWrapper('export CODEX_HOME=~', 'codex', env)).toBe('/home/fy');
    expect(harnessHomeFromWrapper('export CODEX_HOME="$ROOT/codex"', 'codex', env)).toBe('/srv/codex');
    expect(harnessHomeFromWrapper('export CODEX_HOME="${ROOT}/codex/$HOME"', 'codex', env)).toBe('/srv/codex//home/fy');
  });

  test('fails closed: an unresolved variable, a tilde with no HOME and a relative path name no home', () => {
    expect(harnessHomeFromWrapper('export CODEX_HOME="$MISSING/codex"', 'codex', env)).toBeUndefined();
    expect(harnessHomeFromWrapper('export CODEX_HOME="$EMPTY/codex"', 'codex', env)).toBeUndefined();
    expect(harnessHomeFromWrapper('export CODEX_HOME=~/.codex', 'codex', {})).toBeUndefined();
    expect(harnessHomeFromWrapper('export CODEX_HOME=relative/codex', 'codex', env)).toBeUndefined();
    expect(harnessHomeFromWrapper('export CODEX_HOME=~other/codex', 'codex', env)).toBeUndefined();
  });
});

describe('the transcript arguments a relaunch must carry', () => {
  type Provenance = Parameters<typeof transcriptLaunchArguments>[1];
  const provenance = (more: { harnessSessionId?: string; correlationToken?: string }): Provenance =>
    ({ v: 1, home: '/harness/home', identity: 'established', ...more }) as unknown as Provenance;

  test('a Claude session is relaunched on the id its start minted, and a fresh one takes nothing', () => {
    expect(transcriptLaunchArguments('claude', provenance({ harnessSessionId: 'abc-123' }))).toEqual([
      '--session-id',
      'abc-123',
    ]);
    expect(transcriptLaunchArguments('claude', provenance({}))).toEqual([]);
    expect(transcriptLaunchArguments('claude', undefined)).toEqual([]);
  });

  test('a Codex session whose thread is known resumes it, and a fresh one takes nothing', () => {
    expect(transcriptLaunchArguments('codex', provenance({ harnessSessionId: 'thread-1' }))).toEqual([
      'resume',
      'thread-1',
    ]);
    expect(transcriptLaunchArguments('codex', provenance({}))).toEqual([]);
    expect(transcriptLaunchArguments('codex', undefined)).toEqual([]);
  });

  test('a Codex session with a correlation token declares it again, after the resume when both are known', () => {
    expect(transcriptLaunchArguments('codex', provenance({ correlationToken: 'tok-1' }))).toEqual([
      '--add-dir',
      'tok-1/codex-correlation/unreachable',
    ]);
    expect(
      transcriptLaunchArguments('codex', provenance({ harnessSessionId: 'thread-1', correlationToken: 'tok-1' })),
    ).toEqual(['resume', 'thread-1', '--add-dir', 'tok-1/codex-correlation/unreachable']);
  });
});
