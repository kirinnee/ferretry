import { describe, expect, it } from 'bun:test';
import { splitMarkers } from '../../../app/lib/review-model.ts';

describe('how marked text is read', () => {
  it('counts a run of the same marker once instead of drawing a million marks', () => {
    const segments = splitMarkers(`a${'⟨U+200B⟩'.repeat(1000)}b`);
    expect(segments).toEqual([
      { marker: false, text: 'a' },
      { marker: true, text: '⟨U+200B ×1,000⟩' },
      { marker: false, text: 'b' },
    ]);
  });
});
