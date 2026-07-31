import { describe, expect, it } from 'bun:test';
import { displayCallsign, shortSessionId } from '../../src/lib/callsign.ts';

describe('displayCallsign', () => {
  it('title-cases every hyphen-separated segment', () => {
    expect(displayCallsign('ms-98-uuot')).toBe('Ms-98-Uuot');
  });

  it('answers with an empty string rather than a placeholder when there is no callsign', () => {
    expect(displayCallsign(undefined)).toBe('');
    expect(displayCallsign(null)).toBe('');
    expect(displayCallsign('   ')).toBe('');
  });

  it('survives a slug with empty segments', () => {
    expect(displayCallsign('a--b')).toBe('A--B');
  });

  it('leaves the raw form alone — it only ever produces a new string to render', () => {
    const raw = 'ms-98';

    expect(displayCallsign(raw)).toBe('Ms-98');
    expect(raw).toBe('ms-98');
  });
});

describe('shortSessionId', () => {
  it('truncates a long id to its head with an ellipsis', () => {
    expect(shortSessionId('ms9hi4ts-b22751c4')).toBe('ms9hi4ts…');
  });

  it('shows an id short enough to fit whole rather than padding it with a lie', () => {
    expect(shortSessionId('ms9hi4ts')).toBe('ms9hi4ts');
    expect(shortSessionId('')).toBe('');
  });
});
