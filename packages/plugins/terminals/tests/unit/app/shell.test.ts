import { describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import { GRANT_REFUSALS, grantRefusalCode, STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import {
  assertScopeDaemon,
  daemonConnection,
  daemonSessionKey,
  daemonSessionScope,
  grantRefusalNotice,
  grantRefusalText,
  REFUSAL_BY_CODE,
} from '../../../app/shell.ts';

describe('the shell seam', () => {
  it('keys a session by its daemon, so one session id on two daemons is two sessions', () => {
    const a = daemonSessionScope(daemonConnection('alpha'), 'shared');
    const b = daemonSessionScope(daemonConnection('beta'), 'shared');
    expect(daemonSessionKey(a)).not.toBe(daemonSessionKey(b));
    expect(daemonSessionKey(a)).toBe(JSON.stringify(['alpha', 'shared']));
  });

  it('refuses an empty session id and a scope that names another daemon', () => {
    expect(() => daemonSessionScope(daemonConnection('alpha'), '  ')).toThrow('sessionId must not be empty');
    const scope = daemonSessionScope(daemonConnection('alpha'), 'shared');
    expect(() => assertScopeDaemon(daemonConnection('beta'), scope)).toThrow(
      'terminal scope must belong to the requested daemon',
    );
    expect(() => assertScopeDaemon(daemonConnection('alpha'), scope)).not.toThrow();
  });
});

describe('a grant refusal, worded', () => {
  const refused = (status: number, code: string, message = 'the daemon’s own sentence') =>
    new DaemonCallError(status, code, message);

  it('words each of Gate’s refusal codes, keeping the daemon’s own sentence as the detail', () => {
    const cases: [string, string][] = [
      ['grant_not_granted', 'switched this off'],
      ['grant_device_not_granted', 'has not been given it'],
      ['grant_step_up_required', 'needs your passkey'],
      ['grant_undetermined', 'could not read its own grant document'],
    ];
    for (const [code, words] of cases) {
      const notice = grantRefusalNotice(refused(403, code));
      expect(notice?.guidance.explanation).toContain(words);
      expect(notice?.detail).toBe('the daemon’s own sentence');
    }
  });

  it('keeps the codes Gate’s contract names, so a refusal Gate adds is not silently unworded', () => {
    for (const refusal of GRANT_REFUSALS.filter(each => each !== 'granted'))
      expect(REFUSAL_BY_CODE[grantRefusalCode(refusal)]).toBe(refusal);
    expect(REFUSAL_BY_CODE[STEP_UP_REQUIRED_CODE]).toBe('step-up-required');
  });

  it('words a passkey refusal as one sentence in the panel’s own name, and keeps the daemon’s sentence for every other refusal', () => {
    const passkey = grantRefusalText(refused(403, 'grant_step_up_required'), 'Processes');
    expect(passkey).toBe('Using Processes needs your passkey — confirm on this device and it goes ahead.');
    expect(grantRefusalText(refused(403, 'grant_step_up_required'), 'the Console')).toContain('Using the Console');
    const switchedOff = grantRefusalText(refused(403, 'grant_not_granted'), 'Terminals') ?? '';
    expect(switchedOff).toContain('switched this off');
    expect(switchedOff).toEndWith('the daemon’s own sentence');
    expect(grantRefusalText(refused(403, 'grant_not_granted', ''), 'Terminals')).toBe(
      'The operator of this machine switched this off. It is turned back on on the host.',
    );
    expect(grantRefusalText(new Error('network down'), 'Terminals')).toBeNull();
    expect(grantRefusalText(null, 'Terminals')).toBeNull();
  });

  it('answers a 503 from an unreadable grant document, and nothing for any other failure', () => {
    expect(grantRefusalNotice(refused(503, 'grants_undetermined'))?.refusal).toBe('undetermined');
    expect(grantRefusalNotice(refused(404, 'grant_not_granted'))).toBeNull();
    expect(grantRefusalNotice(refused(403, 'something_else'))).toBeNull();
    expect(grantRefusalNotice(new Error('network down'))).toBeNull();
    expect(grantRefusalNotice(null)).toBeNull();
  });
});
