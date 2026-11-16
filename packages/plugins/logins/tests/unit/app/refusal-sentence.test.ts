import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { refusalSentence } from '../../../app/lib/client.ts';

const named = (name: string, message: string): Error => Object.assign(new Error(message), { name });

describe('refusalSentence — what a person reads when a call fails', () => {
  it('uses the daemon’s own sentence, or says it refused with the status', () => {
    expect(refusalSentence({ status: 403, code: 'denied', message: '  Not allowed here.  ' })).toBe(
      'Not allowed here.',
    );
    expect(refusalSentence({ status: 500, code: 'boom', message: '   ' })).toBe('This machine refused it (500).');
  });

  it('says the two copies are probably on different versions when the answer does not parse', () => {
    const failure = z.object({ id: z.string() }).safeParse({}).error;
    expect(failure).toBeInstanceOf(z.ZodError);
    expect(refusalSentence(failure)).toContain('probably on different versions');
  });

  it('says the machine did not answer when what was thrown is not an error', () => {
    expect(refusalSentence('nope')).toBe('This machine didn’t answer. Check it is awake and try again.');
    expect(refusalSentence(null)).toBe('This machine didn’t answer. Check it is awake and try again.');
  });

  it('passes a self-worded error’s own message through', () => {
    expect(refusalSentence(named('DeviceNotAcceptedError', 'This device was revoked.'))).toBe(
      'This device was revoked.',
    );
  });

  it('falls back to the plain sentence for a self-worded error with no message of its own', () => {
    expect(refusalSentence(named('DaemonOutdatedError', '  '))).toBe(
      'This machine didn’t answer. Check it is awake and try again.',
    );
  });

  it('warns that a broken relay session may still have done it', () => {
    expect(refusalSentence(named('RelaySessionError', 'socket closed.'))).toBe(
      'The connection to this machine broke before it answered (socket closed). It may still have done it — check before trying again.',
    );
  });

  it('names the reason when the machine simply did not answer', () => {
    expect(refusalSentence(new Error('timed out'))).toBe(
      'This machine didn’t answer (timed out). Check it is awake and try again.',
    );
  });
});
