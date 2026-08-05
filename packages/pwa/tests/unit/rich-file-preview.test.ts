import { describe, expect, it } from 'bun:test';
import {
  bytesFromBase64,
  parsePreviewCsv,
  richFileKind,
  richFileMime,
} from '../../src/components/rich-file-preview.tsx';

describe('rich file preview classification', () => {
  it('recognises only the bounded preview formats', () => {
    expect(richFileKind('report.HTML')).toBe('html');
    expect(richFileKind('report.htm')).toBe('html');
    expect(richFileKind('report.pdf')).toBe('pdf');
    expect(richFileKind('photo.webp')).toBe('raster');
    expect(richFileKind('diagram.svg')).toBe('svg');
    expect(richFileKind('table.csv')).toBe('csv');
    expect(richFileKind('secret.env')).toBeNull();
  });

  it('uses a document type for every object URL', () => {
    expect(richFileMime('report.htm', 'html')).toBe('text/html;charset=utf-8');
    expect(richFileMime('photo.jpeg', 'raster')).toBe('image/jpeg');
    expect(richFileMime('diagram.svg', 'svg')).toBe('image/svg+xml');
  });

  it('decodes fetched bytes instead of putting a daemon credential in a document URL', () => {
    expect(bytesFromBase64('AAH/')).toEqual(new Uint8Array([0, 1, 255]));
  });
});

describe('bounded CSV preview parsing', () => {
  it('keeps quoted commas and newlines in one escaped cell', () => {
    expect(parsePreviewCsv('name,note\nAda,"one, two\nand three"')).toEqual({
      rows: [
        ['name', 'note'],
        ['Ada', 'one, two\nand three'],
      ],
      truncated: false,
    });
  });

  it('caps generated tables rather than allocating an unbounded grid', () => {
    const rows = Array.from({ length: 401 }, (_, index) => `row-${index}`).join('\n');
    const parsed = parsePreviewCsv(rows);
    expect(parsed.rows).toHaveLength(400);
    expect(parsed.truncated).toBe(true);
  });
});
