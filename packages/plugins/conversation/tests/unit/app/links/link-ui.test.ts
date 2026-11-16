import { describe, expect, it } from 'bun:test';
import { DaemonCallError, RelaySessionError } from '@ferretry/app';
import { z } from 'zod';
import { guarded, linkRefusalSentence } from '../../../../app/links/link-ui.tsx';

/** The sentences a failed links read or keep shows, as today's change refusal worded them. */

const relayError = (message: string): Error => {
  const error = new Error(message);
  error.name = 'RelaySessionError';
  return error;
};

describe('the sentence for a failed links read or keep', () => {
  it("passes the daemon's own sentence through, or counts the status when it gave none", () => {
    expect(linkRefusalSentence(new DaemonCallError(409, 'conflict', 'That conversation is already kept.'))).toBe(
      'That conversation is already kept.',
    );
    expect(linkRefusalSentence(new DaemonCallError(502, 'bad', '  '))).toBe('This machine refused the change (502).');
  });

  it('says nothing was changed when the machine did not answer', () => {
    expect(linkRefusalSentence('boom')).toBe(
      'This machine didn’t answer, so nothing was changed. Check it is awake and try again.',
    );
    expect(linkRefusalSentence(new Error(''))).toBe('This machine didn’t answer. Check it is awake and try again.');
  });

  it('puts the error in parentheses without its trailing full stop', () => {
    expect(linkRefusalSentence(new Error('socket closed.  '))).toBe(
      'This machine didn’t answer (socket closed). Check it is awake and try again.',
    );
  });

  it('does not invite a retry of a keep a dropped relay session may have carried through', () => {
    for (const error of [
      relayError('the relay closed the session.'),
      new RelaySessionError('the relay closed', 1006),
    ]) {
      const sentence = linkRefusalSentence(error);
      expect(sentence).toStartWith('The connection to this machine broke before it answered (the relay closed');
      expect(sentence).toEndWith('It may still have made the change — check before trying again.');
      expect(sentence).not.toContain('didn’t answer');
      expect(sentence).not.toContain('..');
    }
  });

  it('says a differently shaped answer is a version mismatch', async () => {
    const failure = z.string().safeParse(1).error;
    expect(linkRefusalSentence(failure)).toContain('probably on different versions');
    const result = await guarded(async () => {
      throw new Error('offline');
    });
    expect(result).toEqual({
      kind: 'refused',
      sentence: 'This machine didn’t answer (offline). Check it is awake and try again.',
    });
  });
});
