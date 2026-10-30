import { describe, expect, test } from 'bun:test';
import { PEER_PREVIEW_CHARS, peerPreview } from '../../src/lib/peer-preview.ts';

describe('peerPreview', () => {
  test('a short one-line message is shown whole and is not truncated', () => {
    expect(peerPreview('On it.')).toEqual({ preview: 'On it.', truncated: false });
  });

  test('takes the first non-empty line as plain text and notes there is more', () => {
    expect(peerPreview('\n## **Status** report\n\n- one\n- two')).toEqual({
      preview: 'Status report',
      truncated: true,
    });
  });

  test('strips list and quote markers from the first line', () => {
    expect(peerPreview('> quoted').preview).toBe('quoted');
    expect(peerPreview('1. first step').preview).toBe('first step');
  });

  test('cuts a long line at a word boundary within the limit and says so', () => {
    const { preview, truncated } = peerPreview(`${'word '.repeat(60)}end`);
    expect(truncated).toBe(true);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(PEER_PREVIEW_CHARS + 1);
    expect(preview.slice(0, -1).endsWith(' ')).toBe(false);
  });

  test('hard-cuts a line with no usable space', () => {
    const { preview } = peerPreview('x'.repeat(300));
    expect(preview).toBe(`${'x'.repeat(PEER_PREVIEW_CHARS)}…`);
  });

  test('an empty message previews as nothing', () => {
    expect(peerPreview('  \n ')).toEqual({ preview: '', truncated: false });
  });
});
