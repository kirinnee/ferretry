import { beforeAll, describe, expect, it } from 'bun:test';
import {
  ALL_CHIP,
  accountSentence,
  catalogChips,
  filterRows,
  installPlan,
  landedSentence,
  likelyNewFolder,
  normalizeProjectPath,
  PICK_A_PLACE,
  projectHolding,
  readsPlace,
  scopeLine,
  skillRows,
  unreachableLine,
  updatedLine,
} from '../../../../app/features/add-skills/add-skills-model.ts';
import { cardState } from '../../../../app/features/shared/shared-screens-model.ts';
import { installRecord } from '../support/catalog-views.ts';
import { okAttempt, otherCatalogView, type SharedItemFixture, sharedItemFixture } from '../support/shared-screens.ts';

const projects = [
  { name: 'root', path: '/work' },
  { name: 'app', path: '/work/app/' },
];
const place = { cwd: '/work/app/src', harness: 'claude' as const, runtime: 'box' };
const project = { scope: 'project' as const, projectRoot: '/work/app', harness: 'claude' as const };
const at = (target: unknown) => ({ ...installRecord('skill', 'pdf-tools'), target }) as never;

describe('S-0010 where the Add skills page puts a skill, and how it says so', () => {
  it('finds the deepest registered project that holds the folder', () => {
    expect(projectHolding('/work/app/src', projects)?.name).toBe('app');
    expect(projectHolding('/work', projects)?.name).toBe('root');
    expect(projectHolding('/elsewhere', projects)).toBeUndefined();
    expect(normalizeProjectPath('/work/app///')).toBe('/work/app');
    expect(normalizeProjectPath('/')).toBe('/');
  });

  it('prefers this project, then this account, and otherwise asks', () => {
    expect(installPlan(place, projects, []).scope).toBe('project');
    const account = installPlan({ ...place, cwd: '/elsewhere' }, projects, [
      { id: 'r1', wrapper: 'box', profile: 'p', harness: 'claude-code' },
    ]);
    expect(account).toMatchObject({ scope: 'runtime', runtimeId: 'r1', sentence: accountSentence('box') });
    expect(scopeLine(account)).toContain('this account');
    for (const unplaced of [
      installPlan({ ...place, cwd: '' }, projects, []),
      installPlan({ ...place, cwd: undefined }, projects, []),
      installPlan({ ...place, runtime: undefined, cwd: '/elsewhere' }, projects, []),
    ]) {
      expect(unplaced.scope).toBe('none');
      expect(scopeLine(unplaced)).toBe(PICK_A_PLACE);
    }
  });

  it('knows whether the ferret reads the place an install went to', () => {
    const plan = installPlan(place, projects, []);
    expect(readsPlace(at(project), plan, 'claude')).toBe(true);
    expect(readsPlace(at({ ...project, harness: 'codex' }), plan, 'claude')).toBe(false);
    expect(readsPlace(at({ ...project, projectRoot: '/other' }), plan, 'claude')).toBe(false);
    expect(readsPlace(at({ scope: 'runtime', runtime: 'r1', profile: 'p' }), plan, 'claude')).toBe(false);
    expect(landedSentence(at({ ...project, projectRoot: '/other' }), plan, [], 'claude')).toBe(
      'Installed pdf-tools on the project /other. This ferret does not read that place, so it is not active here.',
    );
    expect(likelyNewFolder(at(project), ['user'])).toBe(true);
    expect(likelyNewFolder(at({ scope: 'runtime', runtime: 'r', profile: 'p' }), ['user'])).toBe(false);
  });

  it('lists nothing from a catalog that did not verify', () => {
    expect(skillRows({ kind: 'ok', blocks: [{ kind: 'problem' }] } as never, 'p', 'P', new Map())).toEqual([]);
  });

  it('words the time and the unreachable publishers', () => {
    expect(updatedLine(Date.parse('2026-11-08T12:00:00Z'), Date.parse('2026-11-08T12:05:00Z'))).toBe(
      'Updated 5 minutes ago',
    );
    expect(unreachableLine(['A'])).toBe('Could not reach A, so the list may be out of date.');
    expect(unreachableLine(['A', 'B', 'C'])).toBe('Could not reach A, B and C, so the list may be out of date.');
  });
});

let shared: SharedItemFixture;
beforeAll(async () => {
  shared = await sharedItemFixture();
});

describe('which catalog a skill is from', () => {
  const stateOf = (...views: ReturnType<typeof otherCatalogView>[]) => {
    const state = cardState(okAttempt({ ...shared.browse, catalogs: views }));
    if (state.kind !== 'ok') throw new Error('expected an ok card');
    return state;
  };
  const rowsOf = (...views: ReturnType<typeof otherCatalogView>[]) =>
    skillRows(stateOf(...views), 'pub', 'Studio', new Map());

  it('keeps the catalog on each row, apart from the publisher', () => {
    expect(rowsOf(shared.view)[0]).toMatchObject({
      catalogKey: `pub/${shared.view.catalogId}`,
      catalogName: "Kirin's catalog",
      publisher: 'Studio',
    });
  });

  it('offers All and one chip per catalog, counting what the search kept', () => {
    const all = rowsOf(shared.view, otherCatalogView(shared));
    expect(catalogChips(all, all).map(chip => [chip.key === ALL_CHIP ? 'all' : chip.label, chip.count])).toEqual([
      ['all', 2],
      ["Kirin's catalog", 1],
      ['Design catalog', 1],
    ]);
    expect(catalogChips(all, filterRows(all, 'ocr-tools')).map(chip => chip.count)).toEqual([1, 0, 1]);
  });

  it('offers no chips for one catalog, and names two catalogs of one name with their publisher', () => {
    expect(catalogChips(rowsOf(shared.view), rowsOf(shared.view))).toEqual([]);
    const same = [
      ...rowsOf(shared.view),
      ...skillRows(stateOf(otherCatalogView(shared, "Kirin's catalog")), 'other', 'Guild', new Map()),
    ];
    expect(catalogChips(same, same).map(chip => chip.label)).toEqual([
      'All catalogs',
      "Kirin's catalog (Studio)",
      "Kirin's catalog (Guild)",
    ]);
  });
});
