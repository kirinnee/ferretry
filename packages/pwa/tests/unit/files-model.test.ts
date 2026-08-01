import { describe, expect, it } from 'bun:test';
import {
  UNOPENABLE_NAME_REASON,
  changeRowLabel,
  crumbs,
  entryRefusal,
  formatBytes,
  isMarkdownPath,
  isOpenablePath,
  joinRel,
  normalizeRel,
  parseUnifiedDiff,
  renderableDiffLines,
  sortFsEntries,
  splitHighlightedLines,
  statusChip,
} from '../../src/components/files-model.ts';

describe('files model', () => {
  it('normalizes navigation without rewriting unsupported daemon paths into another file', () => {
    expect(normalizeRel('/src//lib/../  file.ts')).toBe('src/  file.ts');
    expect(joinRel('src/lib', '../index.ts')).toBe('src/index.ts');
    expect(isOpenablePath('src/a\\b.ts')).toBeFalse();
    expect(entryRefusal({ name: 'a\\b.ts', type: 'file' })).toBe(UNOPENABLE_NAME_REASON);
    expect(entryRefusal({ name: '.env', type: 'dir', denied: true })).toContain('denylisted');
  });

  it('keeps tree/list ordering, crumbs, markdown detection and byte formatting stable', () => {
    expect(
      sortFsEntries([
        { name: 'z2', type: 'file' },
        { name: 'z10', type: 'file' },
        { name: 'src', type: 'dir' },
      ]).map(row => row.name),
    ).toEqual(['src', 'z2', 'z10']);
    expect(crumbs('src/lib')).toEqual([
      { label: 'root', path: '' },
      { label: 'src', path: 'src' },
      { label: 'lib', path: 'src/lib' },
    ]);
    expect(isMarkdownPath('README.MDX')).toBeTrue();
    expect(formatBytes(1024)).toBe('1.0 KB');
  });

  it('balances highlight spans across independently-rendered rows', () => {
    expect(splitHighlightedLines('<span class="comment">one\ntwo</span>')).toEqual([
      '<span class="comment">one</span>',
      '<span class="comment">two</span>',
    ]);
  });

  it('renders porcelain details in both the chip and accessible row label', () => {
    const chip = statusChip('MM');
    expect(chip).toMatchObject({ code: 'M', label: 'Modified', detail: 'staged and unstaged' });
    expect(changeRowLabel('src/a.ts', chip, 'src/old.ts')).toBe(
      'Modified (staged and unstaged): src/a.ts from src/old.ts. Open diff',
    );
    expect(statusChip('AA')).toMatchObject({ code: 'U', detail: 'unmerged' });
  });

  it('parses hunk content that resembles file headers and hides plumbing only', () => {
    const parsed = parseUnifiedDiff(
      'diff --git a/a b/a\nindex abcd..ef01 100644\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n---\n+++\n',
    );
    expect(parsed).toMatchObject({ added: 1, removed: 1, binary: false });
    expect(parsed.lines.filter(line => line.kind === 'del')[0]).toMatchObject({ text: '--', oldNo: 1 });
    expect(parsed.lines.filter(line => line.kind === 'add')[0]).toMatchObject({ text: '++', newNo: 1 });
    expect(renderableDiffLines(parsed).map(line => line.text)).toEqual(['@@ -1,2 +1,2 @@', '--', '++']);
  });
});
