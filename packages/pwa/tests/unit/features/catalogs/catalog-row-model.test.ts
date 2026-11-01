import { describe, expect, it } from 'bun:test';
import {
  canAdd,
  ownedMatches,
  ownedVersion,
  removeLabel,
  rowChips,
  sharePlan,
  versionChip,
} from '../../../../src/features/catalogs/catalog-row-model.ts';
import { installRecord, ownedCatalog } from '../../../support/catalog-views.ts';

const PATH = '/home/k/.claude/skills/pdf-tools/SKILL.md';
const skillPath = { kind: 'skill', skill: PATH } as const;
const skillName = { kind: 'skill', skill: 'pdf-tools' } as const;
const mcp = (id: string) => ({ kind: 'mcp', mcp: id }) as const;
const mcpItem = { kind: 'mcp', name: 'github', source: { kind: 'mcp', id: 'srv-1', name: 'github' } };

describe('ownedMatches', () => {
  const catalog = ownedCatalog();

  it('matches a skill by its exact SKILL.md path', () => {
    expect(ownedMatches([catalog], skillPath).map(match => match.item.name)).toEqual(['pdf-tools']);
    expect(ownedMatches([catalog], { kind: 'skill', skill: '/elsewhere/pdf-tools/SKILL.md' })).toEqual([]);
    expect(ownedMatches([catalog], { kind: 'skill', skill: 'C:\\skills\\pdf-tools\\SKILL.md' })).toEqual([]);
  });

  it('matches a skill known only by name, by that name', () => {
    expect(ownedMatches([catalog], skillName)).toHaveLength(1);
    expect(ownedMatches([catalog], { kind: 'skill', skill: 'other' })).toEqual([]);
  });

  it('matches a server by its id and never mixes kinds', () => {
    const withMcp = ownedCatalog({}, mcpItem);
    expect(ownedMatches([withMcp], mcp('srv-1'))).toHaveLength(1);
    expect(ownedMatches([withMcp], mcp('srv-2'))).toEqual([]);
    expect(ownedMatches([catalog], mcp('srv-1'))).toEqual([]);
    expect(ownedMatches([withMcp], skillPath)).toEqual([]);
  });

  it('does not count an item that was withdrawn', () => {
    const gone = ownedCatalog({}, { withdrawnAt: '2026-10-31T09:30:00.000Z' });
    expect(ownedMatches([gone], skillPath)).toEqual([]);
  });
});

describe('sharePlan and ownedVersion', () => {
  const one = ownedCatalog();
  const other = ownedCatalog({ id: `cat_${'d'.repeat(22)}`, name: 'Second' });

  it('plans none, one and many', () => {
    expect(sharePlan([])).toEqual({ kind: 'none' });
    expect(sharePlan(ownedMatches([one], skillPath))).toMatchObject({ kind: 'one', catalog: { name: 'Team skills' } });
    const plan = sharePlan(ownedMatches([one, other], skillPath));
    expect(plan.kind === 'many' && plan.catalogs.map(c => c.name)).toEqual(['Team skills', 'Second']);
  });

  it('reports the newest version any catalog holds', () => {
    expect(ownedVersion([])).toBeNull();
    const bumped = ownedCatalog(
      { id: `cat_${'d'.repeat(22)}` },
      {
        versions: [
          { version: 7, digest: `sha256:${'ab'.repeat(32)}`, size: 1, publishedAt: '2026-10-31T09:00:00.000Z' },
        ],
      },
    );
    expect(ownedVersion(ownedMatches([one], skillPath))).toBe(2);
    expect(ownedVersion(ownedMatches([one, bumped], skillPath))).toBe(7);
    expect(ownedVersion(ownedMatches([bumped, one], skillPath))).toBe(7);
  });
});

describe('rowChips, canAdd, removeLabel', () => {
  it('writes v3 for a version', () => {
    expect(versionChip(3)).toBe('v3');
  });

  it('shows where an installed item came from and its pinned version, and no owned version', () => {
    const chips = rowChips([installRecord()], ownedMatches([ownedCatalog()], skillPath));
    expect(chips.version).toBeNull();
    expect(chips.from?.text).toMatch(/^from kirin-box · v\d+$/);
    expect(chips.from?.title).toContain('From Team skills (kirin-box), pinned to version');
  });

  it('shows the owned version for what a catalog of this machine holds, and nothing otherwise', () => {
    expect(rowChips([], ownedMatches([ownedCatalog()], skillPath))).toEqual({ version: 'v2', from: null });
    expect(rowChips([], [])).toEqual({ version: null, from: null });
  });

  it('offers Add only where nothing was installed from someone', () => {
    expect(canAdd([])).toBe(true);
    expect(canAdd([installRecord()])).toBe(false);
  });

  it('names the catalog on Remove only when several installs exist', () => {
    expect(removeLabel(installRecord(), false)).toBe('Remove');
    expect(removeLabel(installRecord(), true)).toBe('Remove (from Team skills)');
  });
});
