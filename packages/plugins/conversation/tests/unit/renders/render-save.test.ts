import { describe, expect, test } from 'bun:test';
import { renderSaveRefusal } from '../../../daemon/renders/lib/render-save.ts';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';

describe('renderSaveRefusal', () => {
  test('accepts a picture the grammar accepts', () => {
    expect(renderSaveRefusal({ kind: 'svg', alt: 'a square', payload: SVG })).toBeNull();
  });

  test('refuses an alt with a line break before it is read as a second header', () => {
    expect(renderSaveRefusal({ kind: 'svg', alt: 'two\nlines', payload: SVG })).toBe(
      'Alt text must be one line without control characters',
    );
  });

  test('refuses an alt the header parser refuses', () => {
    expect(renderSaveRefusal({ kind: 'svg', alt: '', payload: SVG })).toEqual(expect.any(String));
  });

  test('refuses text that would not come back from UTF-8 as the same bytes', () => {
    const lone = String.fromCharCode(0xd800);
    const sentence = 'The text contains an unpaired UTF-16 surrogate';
    expect(renderSaveRefusal({ kind: 'svg', alt: `bad ${lone}`, payload: SVG })).toBe(sentence);
    expect(renderSaveRefusal({ kind: 'svg', alt: 'fine', payload: `${SVG}${lone}` })).toBe(sentence);
  });

  test('refuses an empty payload', () => {
    expect(renderSaveRefusal({ kind: 'svg', alt: 'fine', payload: '  \n' })).toBe('The payload must not be empty');
  });
});
