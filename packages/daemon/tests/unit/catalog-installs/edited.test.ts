import { describe, it } from 'bun:test';
import should from 'should';
import {
  type EditedHashes,
  editedView,
  editedWords,
  hasEdits,
  NO_EDITS,
  sameEdits,
} from '../../../src/lib/catalog-installs/edited.ts';

/** What was edited here since an install wrote it: how it is told, and when two sightings of it are the same. */

const edits = (files: Record<string, string>, extra: Partial<EditedHashes> = {}): EditedHashes => ({
  files: new Map(Object.entries(files)),
  ...extra,
});

describe('hasEdits', () => {
  it('should be false for nothing, and true for a file, the stored setup, or a server entry', () => {
    should(hasEdits(NO_EDITS)).be.false();
    should(hasEdits(edits({ 'SKILL.md': 'a' }))).be.true();
    should(hasEdits(edits({}, { component: 'a' }))).be.true();
    should(hasEdits(edits({}, { entry: 'a' }))).be.true();
  });
});

describe('editedView', () => {
  it('should name each file by its recorded path, sorted, with the others only when there are some', () => {
    should(editedView(edits({ 'b.md': '1', 'SKILL.md': '2' }), '.claude/skills/pdf/', 'acme')).deepEqual({
      paths: ['.claude/skills/pdf/SKILL.md', '.claude/skills/pdf/b.md'],
    });
    should(editedView(edits({}, { component: 'x', entry: 'y' }), '', 'acme')).deepEqual({
      paths: [],
      component: true,
      entry: 'acme',
    });
  });
});

describe('editedWords', () => {
  it('should say each thing in plain words', () => {
    should(editedWords({ paths: ['a.md', 'b.md'], component: true, entry: 'acme' })).equal(
      'a.md, b.md, the stored setup, the server acme in .mcp.json',
    );
    should(editedWords({ paths: ['a.md'] })).equal('a.md');
  });
});

describe('sameEdits', () => {
  it('should accept no edits whatever was saved', () => {
    should(sameEdits(NO_EDITS, undefined)).be.true();
    should(sameEdits(NO_EDITS, edits({ 'a.md': '1' }))).be.true();
  });

  it('should refuse edits nobody reviewed', () => {
    should(sameEdits(edits({ 'a.md': '1' }), undefined)).be.false();
  });

  it('should accept exactly the hashes that were reviewed', () => {
    should(
      sameEdits(edits({ 'a.md': '1' }, { entry: 'e' }), edits({ 'a.md': '1', 'b.md': '2' }, { entry: 'e' })),
    ).be.true();
  });

  it('should refuse a file edited again, a new one, or a moved setup or entry', () => {
    should(sameEdits(edits({ 'a.md': '2' }), edits({ 'a.md': '1' }))).be.false();
    should(sameEdits(edits({ 'a.md': '1', 'c.md': '3' }), edits({ 'a.md': '1' }))).be.false();
    should(sameEdits(edits({}, { component: 'x' }), edits({}, { component: 'y' }))).be.false();
    should(sameEdits(edits({}, { entry: 'x' }), edits({}))).be.false();
  });
});
