import { describe, expect, it } from 'bun:test';
import { describeRecentFailure } from '../../src/lib/recent-messages.ts';

const UNREADABLE = "part of this conversation couldn't be read yet (it may still be being written, or it is too large)";

describe('describeRecentFailure', () => {
  it('names an unreadable transcript without the daemon’s sentence', () => {
    const raw = 'session has a proved transcript this daemon could not read completely (bad row 12)';
    const failure = describeRecentFailure(new Error(raw));
    expect(failure.reason).toBe(UNREADABLE);
    expect(failure.raw).toBe(raw);
  });

  it('maps the daemon’s transcript_unreadable code to the same words', () => {
    const refused = Object.assign(new Error('session s has a proved transcript, but this daemon could not read it'), {
      name: 'FyHttpError',
      status: 409,
      code: 'transcript_unreadable',
    });
    expect(describeRecentFailure(refused).reason).toBe(UNREADABLE);
  });

  it('says the machine was not reached for a transport failure or a network word', () => {
    const transport = Object.assign(new Error('boom'), { name: 'FyTransportError' });
    expect(describeRecentFailure(transport).reason).toBe("couldn't reach the machine");
    expect(describeRecentFailure(new TypeError('Failed to fetch')).reason).toBe("couldn't reach the machine");
    expect(describeRecentFailure('machine offline').reason).toBe("couldn't reach the machine");
  });

  it('maps refusals by status and falls back to a generic short reason', () => {
    expect(describeRecentFailure(Object.assign(new Error('no'), { status: 403 })).reason).toBe(
      "this device isn't allowed to read it",
    );
    expect(describeRecentFailure(Object.assign(new Error('gone'), { status: 404 })).reason).toBe(
      'the conversation is no longer there',
    );
    expect(describeRecentFailure(new Error('weird internal thing')).reason).toBe('something went wrong reading it');
    expect(describeRecentFailure(null).reason).toBe('something went wrong reading it');
  });
});
