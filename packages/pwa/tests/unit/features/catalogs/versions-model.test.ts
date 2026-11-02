import { describe, expect, it } from 'bun:test';
import {
  changeLabel,
  changesSummary,
  currentDoneSentence,
  flagLabel,
  hunkHeader,
  makeCurrentSentence,
  reachLine,
  reachOf,
  retireSentence,
  retiredDoneSentence,
  sameAsRetiredSentence,
  sameAsVersionSentence,
  unretireSentence,
  usedByLine,
  usedByNames,
  versionActions,
  versionLines,
} from '../../../../src/features/catalogs/versions-model.ts';
import { catalogChanges, CATALOG, ownedCatalog, sharedItem } from '../../../support/catalog-views.ts';
import { memberView } from '../../../support/catalog-sharing.ts';

const AT = Date.parse('2026-10-31T09:00:00.000Z');
const TWO_DAYS = AT + 2 * 24 * 3_600_000;

const threeVersions = () =>
  sharedItem({
    current: 3,
    versions: [
      { version: 1, size: 100, publishedAt: '2026-10-31T09:00:00.000Z', summary: 'a', usedBy: { catalogIds: [] } },
      {
        version: 2,
        size: 120,
        publishedAt: '2026-10-31T09:00:00.000Z',
        retiredAt: '2026-10-31T10:00:00.000Z',
        summary: 'b',
        fileCount: 1,
        usedBy: { catalogIds: [] },
      },
      {
        version: 3,
        size: 12_288,
        publishedAt: '2026-10-31T09:00:00.000Z',
        summary: 'c',
        fileCount: 4,
        usedBy: { catalogIds: [CATALOG] },
      },
    ],
  });

describe('versionLines', () => {
  it('lists the newest first, says current and retired, and points each at the version before it', () => {
    const lines = versionLines(threeVersions(), TWO_DAYS);
    expect(lines.map(line => line.version)).toEqual([3, 2, 1]);
    expect(lines[0]?.text).toBe('v3 · current · 2 days ago · 4 files · 12.0 KB');
    expect(lines[0]).toMatchObject({ current: true, retired: false, previous: 2 });
    expect(lines[1]?.text).toContain('v2 · retired');
    expect(lines[1]?.text).toContain('1 file');
    expect(lines[1]).toMatchObject({ current: false, retired: true, previous: 1 });
    expect(lines[2]).toMatchObject({ previous: null });
    expect(lines[2]?.text).not.toContain('file');
  });
});

describe('who uses and who can see it', () => {
  it('names the catalogs that serve the current version, and a gone one without a name', () => {
    const item = sharedItem();
    expect(usedByNames(item, [ownedCatalog()])).toEqual(['Team skills']);
    expect(usedByNames(item, [])).toEqual(['A catalog that is gone']);
    expect(usedByNames(threeVersions(), [ownedCatalog()])).toEqual(['Team skills']);
  });

  it('says it in a sentence for none, one, two and three', () => {
    expect(usedByLine([])).toBe('No catalog lists it now.');
    expect(usedByLine(['A'])).toBe('Used by A.');
    expect(usedByLine(['A', 'B'])).toBe('Used by A and B.');
    expect(usedByLine(['A', 'B', 'C'])).toBe('Used by A, B and C.');
  });

  it('counts the members who can read a catalog that lists it live', () => {
    const item = sharedItem();
    const other = `cat_${'d'.repeat(22)}`;
    const members = [memberView(), memberView({ catalogIds: [other] }), memberView({ catalogIds: [] })];
    expect(reachOf(item, members)).toBe(1);
    const withdrawn = sharedItem({ catalogs: [{ catalogId: CATALOG, state: 'withdrawn' }] });
    expect(reachOf(withdrawn, members)).toBe(0);
    expect(reachOf(item, null)).toBeNull();
  });

  it('says the head count, or nothing when it is not known', () => {
    expect(reachLine(null)).toBeNull();
    expect(reachLine(0)).toBe('Nobody can see it yet.');
    expect(reachLine(1)).toBe('1 person can see it.');
    expect(reachLine(7)).toBe('7 people can see it.');
  });
});

describe('versionActions', () => {
  const [current, retired, plain] = versionLines(threeVersions(), TWO_DAYS);
  const lines = versionLines(sharedItem({ current: 2 }), TWO_DAYS);
  it('offers only what the daemon would accept, and nothing without versions.2', () => {
    expect(versionActions(lines[0]!, true)).toEqual({ makeCurrent: false, retire: false, unretire: false });
    expect(versionActions(lines[1]!, true)).toEqual({ makeCurrent: true, retire: true, unretire: false });
    expect(versionActions(retired!, true)).toEqual({ makeCurrent: false, retire: false, unretire: true });
    expect(versionActions(current!, true).makeCurrent).toBe(false);
    expect(versionActions(plain!, false)).toEqual({ makeCurrent: false, retire: false, unretire: false });
    expect(versionActions(retired!, false).unretire).toBe(false);
  });
});

describe('the sentences', () => {
  it('say one thing each', () => {
    expect(makeCurrentSentence(2)).toContain('version 2 from now on');
    expect(retireSentence(2)).toContain('stop being offered');
    expect(unretireSentence(2)).toContain('offered again');
    expect(retiredDoneSentence(2, true)).toBe('Version 2 is retired.');
    expect(retiredDoneSentence(2, false)).toBe('Version 2 is back in use.');
    expect(currentDoneSentence(2)).toBe('Version 2 is current now.');
    expect(sameAsVersionSentence(2)).toBe('That is version 2. Make version 2 current instead.');
    expect(sameAsRetiredSentence(2)).toContain('content of retired version 2');
  });
});

describe('the changes', () => {
  it('labels flags and kinds', () => {
    expect(flagLabel('command')).toBe('Command or address');
    expect(flagLabel('script')).toBe('Script');
    expect(flagLabel('runs-on-its-own')).toBe('Runs on its own');
    expect(changeLabel('added')).toBe('Added');
    expect(changeLabel('removed')).toBe('Removed');
    expect(changeLabel('changed')).toBe('Changed');
  });

  it('summarises what changed, and when nothing did', () => {
    expect(changesSummary(catalogChanges())).toBe('2 things changed · 3 the same');
    expect(changesSummary(catalogChanges({ entries: [], unchanged: 4 }))).toContain('No difference');
    expect(changesSummary(catalogChanges({ entries: [], unchanged: 0 }))).toBe('Nothing to compare.');
  });

  it('writes the hunk header', () => {
    expect(hunkHeader({ beforeStart: 3, beforeLines: 4, afterStart: 3, afterLines: 6 })).toBe('@@ -3,4 +3,6 @@');
  });
});
