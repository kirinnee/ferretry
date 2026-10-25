import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { invalidRequestWords } from '../../src/lib/request-refusal.ts';

const RAW = 'the request body is invalid — idea: Too big: expected string to have <=500 characters';
const refused = (message: string, daemonVersion?: string): FyHttpError =>
  new FyHttpError(message, 400, 'invalid_request', undefined, daemonVersion);

describe('invalidRequestWords', () => {
  it('says a known field limit in plain words and keeps the daemon’s text for Details', () => {
    expect(invalidRequestWords(refused(RAW), undefined)).toEqual({
      sentence: 'Your idea can hold at most 500 characters on this machine.',
      details: RAW,
    });
  });

  it('says every issue when several are known', () => {
    const words = invalidRequestWords(
      refused(
        'the request body is invalid — idea: Too big: expected string to have <=500 characters; prompt: Too small: expected string to have >=1 characters',
      ),
      undefined,
    );
    expect(words?.sentence).toBe(
      'Your idea can hold at most 500 characters on this machine. The prompt can’t be empty.',
    );
  });

  it('names an older machine when the app is newer than it, and how to update', () => {
    const words = invalidRequestWords(refused(RAW, '4.84.0'), '4.85.0');
    expect(words?.sentence).toContain('Your idea can hold at most 500 characters on this machine.');
    expect(words?.sentence).toContain('Your machine may be on an older version (it runs 4.84.0; this app is 4.85.0)');
    expect(words?.sentence).toContain('fy daemon update');
    expect(words?.details).toBe(RAW);
  });

  it('does not blame the machine when it is as new as the app, newer, or its version is unknown', () => {
    for (const [daemon, app] of [
      ['4.85.0', '4.85.0'],
      ['4.86.0', '4.85.0'],
      [undefined, '4.85.0'],
      ['4.84.0', undefined],
    ] as const) {
      expect(invalidRequestWords(refused(RAW, daemon), app)?.sentence).not.toContain('older version');
    }
  });

  it('keeps the daemon’s own words for an unknown field, adding the skew note only when it applies', () => {
    const unknown = 'the request body is invalid — nickname: Invalid input';
    expect(invalidRequestWords(refused(unknown), '4.85.0')).toBeUndefined();
    expect(invalidRequestWords(refused(unknown, '4.84.0'), '4.85.0')?.sentence).toStartWith(`${unknown}. Your machine`);
  });

  it('leaves every other failure alone', () => {
    expect(invalidRequestWords(new FyHttpError(RAW, 500, 'invalid_request'), '4.85.0')).toBeUndefined();
    expect(invalidRequestWords(new FyHttpError(RAW, 400, 'something_else'), '4.85.0')).toBeUndefined();
    expect(invalidRequestWords('boom', '4.85.0')).toBeUndefined();
  });
});
