import { describe, expect, test } from 'bun:test';
import { checkFor, STEP_CHECKS } from '../../../cli/lib/checks.ts';

const read = (key: string, answer: unknown) => {
  const check = STEP_CHECKS[key];
  if (check === undefined) throw new Error(`no check for ${key}`);
  return check.read(answer, 'fy');
};
const login = (store: string, word: string, shared = false) => ({
  store,
  sharedWithTerminal: shared,
  status: { word },
});

describe('first-run step checks', () => {
  test('a harness is found when its update view reads an installed version', () => {
    expect(read('claude-code:harness', { installed: { state: 'ok', version: '2.1.0' } })).toEqual({
      kind: 'found',
      line: 'Claude Code 2.1.0 is installed.',
    });
    expect(read('codex:harness', { installed: { state: 'ok', version: '0.5.0' } })).toMatchObject({ kind: 'found' });
  });

  test('a harness that is absent or unreadable is missing, with the sentence that names it', () => {
    for (const installed of [null, { state: 'unreadable', reason: 'x' }])
      expect(read('claude-code:harness', { installed })).toEqual({
        kind: 'missing',
        line: 'Claude Code was not found on this machine.',
        remedy: 'Install Claude Code, then run `fy onboard` again.',
      });
  });

  test('each harness check reads its own plugin route', () => {
    expect(checkFor('claude-code', 'harness')?.route).toBe('GET /v1/claude-code/update');
    expect(checkFor('codex', 'harness')?.route).toBe('GET /v1/codex/update');
    expect(checkFor('logins', 'login')?.route).toBe('GET /v1/logins');
    expect(checkFor('shells', 'nix')?.route).toBe('GET /v1/shells/nix');
    expect(checkFor('runtimes', 'runtimes')?.route).toBe('GET /v1/runtimes');
    expect(checkFor('nobody', 'step')).toBeUndefined();
  });

  test('a signed-in login of the terminal (host store) is found and marked linked', () => {
    expect(read('logins:login', { logins: [login('host', 'ready', true)] })).toEqual({
      kind: 'found',
      line: "A login is signed in, linked to your terminal's own sign-in.",
      linked: true,
    });
  });

  test('a signed-in login Ferretry holds itself is found and is not linked', () => {
    const reading = read('logins:login', { logins: [login('ferretry', 'ready'), login('environment', 'refresh_due')] });
    expect(reading).toEqual({ kind: 'found', line: '2 logins are signed in.' });
  });

  test('logins that need sign-in or are being checked do not count', () => {
    for (const logins of [[], [login('host', 'needs_sign_in', true)], [login('ferretry', 'checking')]])
      expect(read('logins:login', { logins })).toEqual({
        kind: 'missing',
        line: 'No login is signed in yet.',
        remedy: 'Run `fy login add` for one browser sign-in or one API key.',
      });
  });

  test('nix present is found and nix absent says its consequence and remedy as the owner wrote them', () => {
    expect(read('shells:nix', { present: true, version: '2.24.1', path: '/x' })).toEqual({
      kind: 'found',
      line: 'nix 2.24.1 is on this machine.',
    });
    expect(read('shells:nix', { present: false, consequence: 'c', remedy: 'r' })).toEqual({
      kind: 'missing',
      line: 'c',
      remedy: 'r',
    });
  });

  test('runtimes are found when the list has any, from a bare list or a runtimes field', () => {
    expect(read('runtimes:runtimes', [{}])).toEqual({ kind: 'found', line: 'A runtime is set up.' });
    expect(read('runtimes:runtimes', { runtimes: [{}, {}] })).toEqual({
      kind: 'found',
      line: '2 runtimes are set up.',
    });
    expect(read('runtimes:runtimes', { runtimes: [] })).toMatchObject({ kind: 'missing' });
  });

  test('an answer in a shape the reader does not know is unreadable, never found', () => {
    for (const key of Object.keys(STEP_CHECKS)) expect(read(key, 'surprise')).toMatchObject({ kind: 'unreadable' });
  });
});
