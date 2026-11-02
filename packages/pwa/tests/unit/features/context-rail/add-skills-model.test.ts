import { beforeAll, describe, expect, it } from 'bun:test';
import type { CatalogInstall } from '@ferretry/protocol';
import {
  ALL_CHIP,
  accountSentence,
  CLAUDE_LIVE,
  CLAUDE_RELOAD,
  CODEX_NEXT,
  catalogChips,
  filterRows,
  groupByCatalog,
  installPlan,
  landedSentence,
  likelyNewFolder,
  NOT_HERE,
  newInstalls,
  PICK_A_PLACE,
  PROJECT_SENTENCE,
  projectHolding,
  type RuntimeChoice,
  readsPlace,
  scopeLine,
  skillRows,
} from '../../../../src/features/context-rail/add-skills-model.ts';
import { cardState } from '../../../../src/features/shared/shared-screens-model.ts';
import { installRecord } from '../../../support/catalog-views.ts';
import {
  okAttempt,
  otherCatalogView,
  type SharedItemFixture,
  sharedItemFixture,
} from '../../../support/shared-screens.ts';
import { SKILLS, skill } from './context-rail-fixtures.ts';

const projects = [
  { name: 'app', path: '/work/app' },
  { name: 'web', path: '/work/app/web/' },
];
const runtimes: RuntimeChoice[] = [
  { id: 'rt-work', wrapper: 'claude-work', profile: 'default' },
  { id: 'rt-other', wrapper: 'claude-other', profile: 'lean' },
];

const installAt = (target: CatalogInstall['target'], name = 'pdf-tools'): CatalogInstall => ({
  ...installRecord('skill', name),
  target,
});
const inProject = (projectRoot: string, harness: 'claude' | 'codex' = 'claude') =>
  installAt({ scope: 'project', projectRoot, harness });
const inRuntime = (runtime: string) => installAt({ scope: 'runtime', runtime, profile: 'default' });

let shared: SharedItemFixture;
beforeAll(async () => {
  shared = await sharedItemFixture();
});

describe('where an install goes unless the person picks another place', () => {
  it('is the project that holds the session folder, the nested one winning', () => {
    expect(projectHolding('/work/app/src', projects)?.name).toBe('app');
    expect(projectHolding('/work/app/web/pages', projects)?.name).toBe('web');
    expect(projectHolding('/work/app', projects)?.name).toBe('app');
    expect(projectHolding('/work/application', projects)).toBeUndefined();
  });

  it('is This project when the session has a folder in a known project', () => {
    const plan = installPlan({ cwd: '/work/app/src', harness: 'codex', runtime: 'claude-work' }, projects, runtimes);
    expect(plan).toEqual({
      draft: { scope: 'project', projectRoot: '/work/app', harness: 'codex' },
      scope: 'project',
      sentence: 'This project (every session in this folder)',
      projectRoot: '/work/app',
    });
    expect(scopeLine(plan)).toBe(
      'Installs into This project (every session in this folder). You can pick another place when you install.',
    );
  });

  it('is This account, by the runtime the inventory names, when the folder is in no known project', () => {
    const plan = installPlan({ cwd: '/tmp/scratch', harness: 'claude', runtime: 'claude-work' }, projects, runtimes);
    expect(plan.draft).toEqual({ scope: 'runtime', runtime: 'rt-work', profile: 'default' });
    expect(plan.sentence).toBe(accountSentence('claude-work'));
    expect(plan.sentence).toBe('This account (every session on claude-work)');
    expect(plan.runtimeId).toBe('rt-work');
  });

  it('is the account too when the session has no folder at all, or an empty one', () => {
    for (const cwd of [undefined, '']) {
      const plan = installPlan({ cwd, harness: 'claude', runtime: 'claude-other' }, projects, runtimes);
      expect(plan.scope).toBe('runtime');
      expect(plan.runtimeId).toBe('rt-other');
    }
  });

  it('asks the person to pick when neither the project nor the runtime can be told', () => {
    const unknownRuntime = installPlan({ cwd: '/tmp/x', harness: 'claude', runtime: 'gone' }, projects, runtimes);
    const noRuntime = installPlan({ cwd: '/tmp/x', harness: 'claude', runtime: undefined }, projects, runtimes);
    for (const plan of [unknownRuntime, noRuntime]) {
      expect(plan).toEqual({ draft: {}, scope: 'none', sentence: PICK_A_PLACE });
      expect(scopeLine(plan)).toBe(PICK_A_PLACE);
    }
  });
});

describe('the skills of a subscription', () => {
  it('lists only skills of catalogs that verified, named from the publisher and the catalog', () => {
    const state = cardState(okAttempt(shared.browse));
    if (state.kind !== 'ok') throw new Error('expected an ok card');
    const rows = skillRows(state, 'pub', 'Studio', new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: `pub/${shared.view.catalogId}/${shared.skill.itemId}`,
      name: 'pdf-tools',
      from: "Studio · Kirin's catalog",
      version: 'v1',
      summary: 'Split, merge and OCR PDFs',
      installed: false,
    });
    expect(skillRows(state, 'pub', 'Studio', new Map([[shared.skill.itemId, 'pdf-tools']]))[0]?.installed).toBe(true);

    const broken = cardState(
      okAttempt({
        ...shared.browse,
        catalogs: [{ catalogId: shared.view.catalogId, name: 'Broken', revision: 1, problem: 'Not shown.' }],
      }),
    );
    if (broken.kind !== 'ok') throw new Error('expected an ok card');
    expect(skillRows(broken, 'pub', 'Studio', new Map())).toEqual([]);
  });

  it('narrows by every word typed, over name, summary, publisher and catalog', () => {
    const state = cardState(okAttempt(shared.browse));
    if (state.kind !== 'ok') throw new Error('expected an ok card');
    const rows = skillRows(state, 'pub', 'Studio', new Map());
    expect(filterRows(rows, '')).toBe(rows);
    expect(filterRows(rows, '   ')).toBe(rows);
    expect(filterRows(rows, 'PDF')).toHaveLength(1);
    expect(filterRows(rows, 'ocr studio kirin')).toHaveLength(1);
    expect(filterRows(rows, 'pdf nothing')).toHaveLength(0);
  });
});

describe('which catalog a skill is from', () => {
  const rowsOf = (...views: ReturnType<typeof otherCatalogView>[]) => {
    const state = cardState(okAttempt({ ...shared.browse, catalogs: views }));
    if (state.kind !== 'ok') throw new Error('expected an ok card');
    return skillRows(state, 'pub', 'Studio', new Map());
  };

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
      ...skillRows(
        (() => {
          const state = cardState(
            okAttempt({ ...shared.browse, catalogs: [otherCatalogView(shared, "Kirin's catalog")] }),
          );
          if (state.kind !== 'ok') throw new Error('expected an ok card');
          return state;
        })(),
        'other',
        'Guild',
        new Map(),
      ),
    ];
    expect(catalogChips(same, same).map(chip => chip.label)).toEqual([
      'All catalogs',
      "Kirin's catalog (Studio)",
      "Kirin's catalog (Guild)",
    ]);
  });

  it('groups rows by catalog in order, or narrows to the one chosen', () => {
    const all = rowsOf(shared.view, otherCatalogView(shared));
    expect(groupByCatalog(all, ALL_CHIP).map(group => [group.name, group.publisher, group.rows.length])).toEqual([
      ["Kirin's catalog", 'Studio', 1],
      ['Design catalog', 'Studio', 1],
    ]);
    expect(groupByCatalog(all, `pub/${otherCatalogView(shared).catalogId}`).map(group => group.name)).toEqual([
      'Design catalog',
    ]);
    expect(groupByCatalog([], ALL_CHIP)).toEqual([]);
  });
});

describe('what an install changed', () => {
  it('is the records that were not there before', () => {
    const first = inRuntime('rt-work');
    const second = { ...inRuntime('rt-other'), installId: `cin_${'j'.repeat(22)}` as CatalogInstall['installId'] };
    expect(newInstalls([first], [first, second])).toEqual([second]);
    expect(newInstalls([first], [first])).toEqual([]);
  });
});

describe('where it landed', () => {
  const projectPlan = installPlan({ cwd: '/work/app', harness: 'claude', runtime: 'claude-work' }, projects, runtimes);
  const accountPlan = installPlan({ cwd: '/tmp/x', harness: 'claude', runtime: 'claude-work' }, projects, runtimes);

  it('knows whether the session reads the place', () => {
    expect(readsPlace(inProject('/work/app/'), projectPlan, 'claude')).toBe(true);
    expect(readsPlace(inProject('/work/app', 'codex'), projectPlan, 'claude')).toBe(false);
    expect(readsPlace(inProject('/work/other'), projectPlan, 'claude')).toBe(false);
    expect(readsPlace(inProject('/work/app'), accountPlan, 'claude')).toBe(false);
    expect(readsPlace(inRuntime('rt-work'), accountPlan, 'claude')).toBe(true);
    expect(readsPlace(inRuntime('rt-other'), accountPlan, 'claude')).toBe(false);
    expect(readsPlace(inRuntime('rt-work'), projectPlan, 'claude')).toBe(false);
  });

  it('guesses a new skills folder when the session saw no skill of that kind', () => {
    expect(likelyNewFolder(inProject('/work/app'), SKILLS)).toBe(false);
    expect(likelyNewFolder(inRuntime('rt-work'), SKILLS)).toBe(false);
    const bare = { ...SKILLS, skills: [skill({ name: 'babysit-pr', scope: 'ferretry' })] };
    expect(likelyNewFolder(inProject('/work/app'), bare)).toBe(true);
    expect(likelyNewFolder(inRuntime('rt-work'), bare)).toBe(true);
  });

  it('says a Claude skill is active now when the folder was already there', () => {
    expect(landedSentence(inProject('/work/app'), projectPlan, SKILLS, 'claude')).toBe(
      `Installed pdf-tools in ${PROJECT_SENTENCE}. ${CLAUDE_LIVE}`,
    );
    expect(landedSentence(inRuntime('rt-work'), accountPlan, SKILLS, 'claude')).toBe(
      `Installed pdf-tools in This account (every session on claude-work). ${CLAUDE_LIVE}`,
    );
  });

  it('says a Claude skill may need /reload-skills when its folder was probably just made', () => {
    const bare = { ...SKILLS, skills: [] };
    expect(landedSentence(inProject('/work/app'), projectPlan, bare, 'claude')).toContain(CLAUDE_RELOAD);
    expect(CLAUDE_RELOAD).toContain('/reload-skills');
  });

  it('says a Codex skill is active from the next session, and says nothing sure when it cannot tell', () => {
    expect(landedSentence(inProject('/work/app', 'codex'), projectPlan, SKILLS, 'codex')).toBe(
      `Installed pdf-tools in ${PROJECT_SENTENCE}. ${CODEX_NEXT}`,
    );
    const codexPlan = installPlan({ cwd: '/work/app', harness: 'codex', runtime: undefined }, projects, runtimes);
    expect(landedSentence(inProject('/work/app', 'codex'), codexPlan, null, 'codex')).toContain(CODEX_NEXT);
    expect(landedSentence(inProject('/work/app'), projectPlan, null, 'claude')).toContain(CLAUDE_LIVE);
  });

  it('says plainly when the session does not read the place it went to', () => {
    expect(landedSentence(inProject('/work/other'), projectPlan, SKILLS, 'claude')).toBe(
      `Installed pdf-tools on the project /work/other. ${NOT_HERE}`,
    );
    expect(landedSentence(inRuntime('rt-other'), accountPlan, SKILLS, 'claude')).toBe(
      `Installed pdf-tools on the account rt-other. ${NOT_HERE}`,
    );
  });
});
