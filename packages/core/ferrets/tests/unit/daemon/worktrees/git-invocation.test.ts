import { expect, test } from 'bun:test';
import {
  checkedLimit,
  GitProcessError,
  gitEnvironment,
  HARDENED_GIT_ARGUMENTS,
} from '../../../../daemon/lib/worktrees/git-invocation.ts';

test('a git limit is the value given, else the fallback, and a zero is a real limit', () => {
  expect(checkedLimit(5, 10, 'stdout limit')).toBe(5);
  expect(checkedLimit(undefined, 10, 'stdout limit')).toBe(10);
  expect(checkedLimit(0, 10, 'stdout limit')).toBe(0);
});

test('a git limit that is negative, fractional or not finite is refused naming the limit', () => {
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
    let refusal: unknown;
    try {
      checkedLimit(value, 10, 'stderr limit');
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(GitProcessError);
    expect((refusal as GitProcessError).code).toBe('invalid_limit');
    expect((refusal as GitProcessError).message).toBe('stderr limit must be a non-negative safe integer');
  }
});

test('the git environment keeps the caller variables, drops every inherited GIT_ one and pins the rest', () => {
  const environment = gitEnvironment(
    { PATH: '/bin', HOME: '/home/x', GIT_DIR: '/elsewhere', GIT_SSH_COMMAND: 'ssh -v', UNSET: undefined },
    false,
  );
  expect(environment.PATH).toBe('/bin');
  expect(environment.HOME).toBe('/home/x');
  expect(environment).not.toHaveProperty('UNSET');
  expect(environment).not.toHaveProperty('GIT_DIR');
  expect(environment).not.toHaveProperty('GIT_SSH_COMMAND');
  expect(environment).toMatchObject({
    LC_ALL: 'C',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
  });
  expect(environment).not.toHaveProperty('GIT_LITERAL_PATHSPECS');
});

test('literal pathspecs are switched on only when asked for', () => {
  expect(gitEnvironment({}, true).GIT_LITERAL_PATHSPECS).toBe('1');
});

test('git always runs without a pager, hooks or a filesystem monitor', () => {
  const joined = HARDENED_GIT_ARGUMENTS.join(' ');
  expect(joined).toContain('core.pager=cat');
  expect(joined).toContain('core.hooksPath=/dev/null');
  expect(joined).toContain('core.fsmonitor=false');
});
