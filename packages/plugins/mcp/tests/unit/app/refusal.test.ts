import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { DaemonCallError } from '@ferretry/app';
import { changeRefusalSentence, refusalCode } from '../../../app/lib/refusal.ts';

describe('changeRefusalSentence', () => {
  it('uses the daemon’s own words when it gave some, and says the status when it gave none', () => {
    expect(changeRefusalSentence(new DaemonCallError(403, 'grant_refused', 'Not allowed here.'))).toBe(
      'Not allowed here.',
    );
    expect(changeRefusalSentence(new DaemonCallError(500, 'boom', '  '))).toBe(
      'This machine refused the change (500).',
    );
    expect(refusalCode(new DaemonCallError(409, 'mcp_auth_registration', 'x'))).toBe('mcp_auth_registration');
    expect(refusalCode(new Error('x'))).toBeUndefined();
  });

  it('says what went wrong rather than a machine that was silent', () => {
    expect(changeRefusalSentence(new z.ZodError([]))).toContain('probably on different versions');
    expect(changeRefusalSentence('nope')).toContain('didn’t answer, so nothing was changed');
    const relay = Object.assign(new Error('closed'), { name: 'RelaySessionError' });
    expect(changeRefusalSentence(relay)).toContain('may still have made the change');
    const revoked = Object.assign(new Error('This device was revoked.'), { name: 'DeviceNotAcceptedError' });
    expect(changeRefusalSentence(revoked)).toBe('This device was revoked.');
    expect(changeRefusalSentence(new Error('boom'))).toBe(
      'This machine didn’t answer (boom). Check it is awake and try again.',
    );
  });
});
