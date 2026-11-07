import { describe, expect, it } from 'bun:test';
import {
  CLONE_REVIEW_KINDS,
  CLONE_REVIEW_STALE,
  CloneableSecretNameSchema,
  type CloneLoginTarget,
  type CloneReviewItem,
} from '@ferretry/protocol';
import {
  applyHold,
  chooseItem,
  compareItem,
  isStaleReview,
  lastCopiedWords,
  lineDiff,
  linksOnly,
  loginChoices,
  loginTarget,
  nothingDiffers,
  reviewDecisions,
  reviewedLoginTargets,
  reviewGroups,
  reviewItemTitle,
  reviewOutcomes,
  sameMatchedByName,
  sameNames,
  sameTitle,
  unchosenBoth,
  updateCount,
  updateLabel,
  updateWrites,
} from '../../../../../../app/features/fleet/setup/clone-review-model.ts';
import { FULL_REVIEW, ITEMS, NOTHING_REVIEW, review, UPDATE_BUNDLE } from './clone-review-support.ts';
import { bundle } from './setup-support.ts';

describe('the update review, grouped', () => {
  it('lists the groups in reading order, each heading saying what will happen, and never an empty one', () => {
    const groups = reviewGroups(FULL_REVIEW, 'Studio Mac');
    expect(groups.map(group => group.id)).toEqual(['new', 'theirs', 'both', 'mine', 'gone', 'removed-here']);
    expect(groups.map(group => group.title)).toEqual([
      'New on Studio Mac',
      'Changed on Studio Mac',
      'Both changed — pick one',
      'Changed here (kept)',
      'Gone from Studio Mac',
      'You removed these here',
    ]);
    expect(groups.map(group => group.items.length)).toEqual([2, 1, 1, 1, 1, 1]);

    const onlyNew = reviewGroups(review({ items: [ITEMS.newMcp] }), 'Studio Mac');
    expect(onlyNew.map(group => group.id)).toEqual(['new']);
  });

  it('says what each group does by default, and that Both changed leaves the choice to the person', () => {
    const both = reviewGroups(FULL_REVIEW, 'Studio Mac').find(group => group.id === 'both');
    expect(both?.hint).toContain('Nothing is chosen for you');
    const gone = reviewGroups(FULL_REVIEW, 'Studio Mac').find(group => group.id === 'gone');
    expect(gone?.hint).toContain('stay here unless you tick');
  });

  it('titles an item by its kind and name', () => {
    expect(reviewItemTitle(ITEMS.newMcp)).toBe('MCP server · notes');
    expect(reviewItemTitle(ITEMS.newProfile)).toBe('Profile · review');
    expect(reviewItemTitle(ITEMS.goneRuntime)).toBe('Runtime · old-codex');
    expect(reviewItemTitle(ITEMS.theirsHooks)).toBe('Hooks · guard');
  });

  it('never lists a login as an item: only the setup’s own kinds can be a row', () => {
    expect([...CLONE_REVIEW_KINDS]).not.toContain('login');
    expect(JSON.stringify(reviewGroups(FULL_REVIEW, 'Studio Mac'))).not.toContain('login/');
  });
});

describe('the update review, collapsed count', () => {
  it('counts the things already the same and says how many were matched by name', () => {
    expect(sameTitle(FULL_REVIEW)).toBe('6 things already the same');
    expect(sameMatchedByName(FULL_REVIEW)).toBe('2 matched by name');
    expect(sameMatchedByName(review({ same: { count: 3, probable: 0 } }))).toBeNull();
    expect(sameTitle(review({ same: { count: 1, probable: 0 } }))).toBe('1 thing already the same');
  });

  it('opens a list of names only: what the source carries that the review does not list', () => {
    expect(sameNames(UPDATE_BUNDLE, FULL_REVIEW)).toEqual([
      'hooks/lint',
      'instructions/default',
      'profile/default',
      'runtime/claude-default',
      'runtime/claude-review',
      'runtime/codex-default',
    ]);
  });

  it('shows no names when they do not add up to the count, rather than a list that might be wrong', () => {
    expect(sameNames(UPDATE_BUNDLE, review({ items: FULL_REVIEW.items, same: { count: 9, probable: 0 } }))).toBeNull();
  });
});

describe('the choices and the button', () => {
  it('starts with the daemon’s defaults, and nothing at all for an item both sides changed', () => {
    const decisions = reviewDecisions(FULL_REVIEW, {});
    expect(decisions).toEqual({
      'mcp/notes': 'add',
      'profile/review': 'add',
      'hooks/guard': 'take',
      'instructions/main': 'keep',
      'runtime/old-codex': 'keep',
      'profile/legacy': 'keep',
    });
    expect(decisions['settings/shared']).toBeUndefined();
    expect(unchosenBoth(FULL_REVIEW, {}).map(item => item.ref)).toEqual(['settings/shared']);
  });

  it('counts a thing for every item that writes, and for each login that becomes an empty slot', () => {
    // add, add, take; the Both-changed item is not chosen; the login being asked about defaults to an empty slot.
    expect(updateCount(FULL_REVIEW, {}, {})).toBe(4);
    expect(updateCount(FULL_REVIEW, { 'settings/shared': 'take' }, {})).toBe(5);
    expect(updateCount(FULL_REVIEW, { 'settings/shared': 'keep' }, {})).toBe(4);
    // Reusing a login here writes nothing for it.
    expect(updateCount(FULL_REVIEW, { 'settings/shared': 'keep' }, { 'codex-work': 'codex-main' })).toBe(3);
    // A removal and a restore are writes too.
    expect(
      updateCount(
        FULL_REVIEW,
        { 'runtime/old-codex': 'remove', 'profile/legacy': 'add' },
        { 'codex-work': 'codex-main' },
      ),
    ).toBe(5);
  });

  it('words the button: Update N things, one thing, Nothing to copy', () => {
    expect(updateLabel(4)).toBe('Update 4 things');
    expect(updateLabel(1)).toBe('Update 1 thing');
    expect(updateLabel(0)).toBe('Nothing to copy');
  });

  it('holds Apply until every Both-changed item has a choice, and says how many remain', () => {
    const two = review({ items: [ITEMS.bothSettings, ITEMS.bothHooks] });
    expect(applyHold(unchosenBoth(two, {}), 'Studio Mac')).toBe(
      'Choose 2 more under “Both changed” first: keep yours, or use Studio Mac’s.',
    );
    const one = { 'settings/shared': 'keep' } as const;
    expect(applyHold(unchosenBoth(two, one), 'Studio Mac')).toBe(
      'Choose one more under “Both changed” first: keep yours, or use Studio Mac’s.',
    );
    expect(applyHold(unchosenBoth(two, { ...one, 'hooks/lint': 'take' }), 'Studio Mac')).toBeNull();
  });

  it('brings in what a ticked profile needs, and leaves out what needs an unticked component', () => {
    const unticked = chooseItem(FULL_REVIEW, {}, 'mcp/notes', 'skip');
    expect(unticked['mcp/notes']).toBe('skip');
    expect(unticked['profile/review']).toBe('skip');

    const ticked = chooseItem(FULL_REVIEW, unticked, 'profile/review', 'add');
    expect(ticked['profile/review']).toBe('add');
    expect(ticked['mcp/notes']).toBe('add');
  });

  it('sends the login the person picked for one it asked about, and only for those', () => {
    expect(loginChoices(FULL_REVIEW, {})).toEqual({ 'codex-work': 'slot' });
    expect(loginChoices(FULL_REVIEW, { 'codex-work': 'codex-main' })).toEqual({ 'codex-work': 'codex-main' });
    const ask = FULL_REVIEW.logins[1];
    expect(ask && loginTarget(ask, { 'codex-work': 'codex-spare' })).toBe('codex-spare');
    expect(loginChoices(review({}), {})).toEqual({});
  });
});

describe('nothing differs, the stale refusal and Done', () => {
  it('recognises a review with nothing to write and nothing to ask', () => {
    expect(nothingDiffers(NOTHING_REVIEW)).toBe(true);
    expect(nothingDiffers(FULL_REVIEW)).toBe(false);
    expect(nothingDiffers(review({ logins: [{ sourceId: 'x', outcome: 'slot' }] }))).toBe(false);
    expect(
      nothingDiffers(review({ keys: [{ name: CloneableSecretNameSchema.parse('JEV_API_KEY'), outcome: 'newer' }] })),
    ).toBe(false);
  });

  it('knows the sentence a moved review is refused with', () => {
    expect(CLONE_REVIEW_STALE).toBe('Something changed since you reviewed. Review again.');
    expect(isStaleReview(CLONE_REVIEW_STALE)).toBe(true);
    expect(isStaleReview('This machine refused the change (409).')).toBe(false);
    expect(isStaleReview(null)).toBe(false);
  });

  it('lists the outcomes per group once an update is applied', () => {
    const outcomes = reviewOutcomes(FULL_REVIEW, { 'settings/shared': 'take', 'runtime/old-codex': 'remove' });
    expect(outcomes.map(group => [group.id, group.names])).toEqual([
      ['added', ['mcp/notes', 'profile/review']],
      ['updated', ['hooks/guard', 'settings/shared']],
      ['removed', ['runtime/old-codex']],
      ['kept', ['instructions/main', 'profile/legacy']],
    ]);
  });

  it('says when it was last copied in the reader’s calendar, or nothing', () => {
    expect(lastCopiedWords('2026-10-28T09:30:00.000Z')).toContain('Last copied');
    expect(lastCopiedWords('2026-10-28T09:30:00.000Z')).toContain('2026');
    expect(lastCopiedWords(undefined)).toBeNull();
    expect(lastCopiedWords('not a date')).toBeNull();
  });
});

describe('the line diff', () => {
  it('shows what changed with two unchanged lines around it and folds the rest', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
    const after = ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'h', 'i', 'j'].join('\n');
    expect(lineDiff(before, after)).toEqual([
      { kind: 'skip', count: 2 },
      { kind: 'same', text: 'c' },
      { kind: 'same', text: 'd' },
      { kind: 'del', text: 'e' },
      { kind: 'add', text: 'E' },
      { kind: 'same', text: 'f' },
      { kind: 'same', text: 'g' },
      { kind: 'skip', count: 3 },
    ]);
  });

  it('marks added and removed lines at the ends', () => {
    expect(lineDiff('one\n', 'one\ntwo\n')).toEqual([
      { kind: 'same', text: 'one' },
      { kind: 'add', text: 'two' },
    ]);
    expect(lineDiff('one\ntwo\n', 'two\n')).toEqual([
      { kind: 'del', text: 'one' },
      { kind: 'same', text: 'two' },
    ]);
    expect(lineDiff('same\n', 'same\n')).toEqual([{ kind: 'skip', count: 1 }]);
  });

  it('gives up on documents too long to compare line by line, so the caller shows the whole file', () => {
    const long = Array.from({ length: 2500 }, (_, index) => `line ${String(index)}`).join('\n');
    expect(lineDiff(long, `${long}\nmore`)).toBeNull();
  });
});

describe('what the button counts, besides the reviewed items', () => {
  const NONE = { files: 0, controls: false, keys: 0 };

  it('counts each settings file, the controls and each key the one apply handler writes', () => {
    const kept = review({ items: [ITEMS.mineInstructions, ITEMS.goneRuntime] });
    expect(updateWrites(kept, {}, {}, NONE)).toBe(0);
    expect(updateWrites(kept, {}, {}, { files: 2, controls: false, keys: 0 })).toBe(2);
    expect(updateWrites(kept, {}, {}, { files: 0, controls: true, keys: 0 })).toBe(1);
    expect(updateWrites(kept, {}, {}, { files: 0, controls: false, keys: 3 })).toBe(3);
    expect(updateWrites(kept, {}, {}, { files: 1, controls: true, keys: 2 })).toBe(4);
  });

  it('adds them to the reviewed items and the empty slots, never instead of them', () => {
    expect(updateWrites(FULL_REVIEW, { 'settings/shared': 'take' }, {}, NONE)).toBe(
      updateCount(FULL_REVIEW, { 'settings/shared': 'take' }, {}) + 0,
    );
    expect(updateWrites(FULL_REVIEW, { 'settings/shared': 'take' }, {}, { files: 1, controls: true, keys: 1 })).toBe(
      updateCount(FULL_REVIEW, { 'settings/shared': 'take' }, {}) + 3,
    );
  });

  it('knows a review that only links names: nothing differs and some were matched by name', () => {
    expect(linksOnly(NOTHING_REVIEW)).toBe(true);
    expect(linksOnly(review({ same: { count: 12, probable: 0 } }))).toBe(false);
    expect(linksOnly(FULL_REVIEW)).toBe(false);
  });
});

describe('the logins as the review settled them', () => {
  const predicted = new Map<string, CloneLoginTarget>([
    ['claude-work', { kind: 'new', id: 'claude-work-2' }],
    ['codex-work', { kind: 'new', id: 'codex-work', candidates: ['codex-main', 'codex-spare'] }],
    ['api', { kind: 'new', id: 'api' }],
  ]);
  const asking = review({
    logins: [
      { sourceId: 'claude-work', outcome: 'matched', target: 'claude-main' },
      { sourceId: 'codex-work', outcome: 'ask', candidates: ['codex-main', 'codex-spare'] },
      { sourceId: 'api', outcome: 'slot' },
    ],
  });

  it('uses the login the review matched, over the generic rule', () => {
    expect(reviewedLoginTargets(asking, {}, predicted).get('claude-work')).toEqual({
      kind: 'matched',
      id: 'claude-main',
    });
  });

  it('reads a match with no target as the login of the same id', () => {
    const bare = review({ logins: [{ sourceId: 'claude-work', outcome: 'matched' }] });
    expect(reviewedLoginTargets(bare, {}, predicted).get('claude-work')).toEqual({
      kind: 'matched',
      id: 'claude-work',
    });
  });

  it('uses the existing login the person picked, and keeps the predicted slot for an empty one or none', () => {
    expect(reviewedLoginTargets(asking, { 'codex-work': 'codex-spare' }, predicted).get('codex-work')).toEqual({
      kind: 'matched',
      id: 'codex-spare',
    });
    expect(reviewedLoginTargets(asking, { 'codex-work': 'slot' }, predicted).get('codex-work')).toEqual(
      predicted.get('codex-work'),
    );
    expect(reviewedLoginTargets(asking, {}, predicted).get('codex-work')).toEqual(predicted.get('codex-work'));
  });

  it('leaves a login that becomes a new slot as the generic rule named it', () => {
    expect(reviewedLoginTargets(asking, {}, predicted).get('api')).toEqual({ kind: 'new', id: 'api' });
  });
});

describe('this machine’s value beside the source’s', () => {
  const HERE = bundle({
    credentials: [],
    components: {
      settings: { shared: { flags: ['--verbose', '--quiet'] }, empty: { flags: [] } },
      mcp: { notes: { command: 'notes-here' } },
      modelSets: { claude: { models: ['opus'], default: 'opus' } },
    },
    profiles: { default: { layers: ['instructions/default', 'mcp/other'], compactAt: 80 } },
    runtimes: { 'claude-default': { credential: 'claude-mine', profile: 'default', agent: true } },
    files: [],
  });
  const SOURCE = bundle({
    credentials: [],
    components: {
      settings: { shared: { flags: ['--verbose'] } },
      modelSets: { claude: { models: ['opus', 'sonnet'], default: 'opus' } },
    },
    profiles: { default: { layers: ['instructions/default'] } },
    runtimes: { 'claude-default': { credential: 'claude-work', profile: 'default', agent: true } },
    files: [],
  });
  const both = (over: Partial<CloneReviewItem>): CloneReviewItem => ({
    ref: 'settings/shared',
    sourceRef: 'settings/shared',
    kind: 'settings',
    outcome: 'both',
    match: 'key',
    files: [],
    ...over,
  });
  const entry = (label: string, text: string) => ({ label, text, document: false });
  const rows = (item: CloneReviewItem, here: typeof HERE | null = HERE, source: typeof SOURCE | null = SOURCE) => {
    const found = compareItem(item, here, source);
    return found.kind === 'rows' ? found.rows : found.kind;
  };

  it('has nothing to compare for an item that only changed a document', () => {
    expect(compareItem(ITEMS.bothHooks, HERE, SOURCE)).toEqual({ kind: 'none' });
  });

  it('says it could not read this machine, rather than guess, when its own setup is missing or unsound', () => {
    expect(compareItem(ITEMS.bothSettings, null, SOURCE)).toEqual({ kind: 'unreadable' });
    const unsound = bundle({ ...HERE, files: [{ path: 'components/x.md', content: 'orphan' }] });
    expect(compareItem(ITEMS.bothSettings, unsound, SOURCE)).toEqual({ kind: 'unreadable' });
  });

  it('pairs what an item runs line by line, in order, and marks the lines that differ', () => {
    expect(rows(ITEMS.bothSettings)).toEqual([
      { label: 'Launch flag', here: '--verbose', source: '--verbose', differs: false },
      { label: 'Launch flag', here: '--quiet', source: '--dangerously-skip-permissions', differs: true },
    ]);
  });

  it('lists a line only the source has with no value here, and a line only this machine has with none there', () => {
    const only = both({
      runnable: {
        reference: 'settings/shared',
        kind: 'settings',
        name: 'shared',
        entries: [entry('Launch flag', '--verbose'), entry('Environment A', '1')],
      },
    });
    expect(rows(only)).toEqual([
      { label: 'Launch flag', here: '--verbose', source: '--verbose', differs: false },
      { label: 'Environment A', here: null, source: '1', differs: true },
      { label: 'Launch flag', here: '--quiet', source: null, differs: true },
    ]);
  });

  it('leaves a whole document to its line diff, and cuts a very long value', () => {
    const long = 'x'.repeat(500);
    const item = both({
      runnable: {
        reference: 'settings/shared',
        kind: 'settings',
        name: 'shared',
        entries: [
          { label: 'Settings file components/settings/shared.json', text: '{}', document: true },
          entry('Launch flag', long),
        ],
      },
    });
    const found = compareItem(item, HERE, SOURCE);
    if (found.kind !== 'rows') throw new Error('expected rows');
    expect(found.rows).toHaveLength(2);
    expect(found.rows[0]?.source).toBe(`${'x'.repeat(400)}…`);
  });

  it('compares the named fields of a component, a profile and a runtime, each from its own table', () => {
    expect(
      rows(both({ ref: 'modelSets/claude', sourceRef: 'modelSets/claude', kind: 'modelSets', fields: ['models'] })),
    ).toEqual([{ label: 'models', here: '["opus"]', source: '["opus","sonnet"]', differs: true }]);
    expect(
      rows(
        both({
          ref: 'profile/default',
          sourceRef: 'profile/default',
          kind: 'profile',
          fields: ['layers', 'compactAt'],
        }),
      ),
    ).toEqual([
      {
        label: 'layers',
        here: '["instructions/default","mcp/other"]',
        source: '["instructions/default"]',
        differs: true,
      },
      { label: 'compactAt', here: '80', source: null, differs: true },
    ]);
    expect(
      rows(
        both({
          ref: 'runtime/claude-default',
          sourceRef: 'runtime/claude-default',
          kind: 'runtime',
          fields: ['login'],
        }),
      ),
    ).toEqual([{ label: 'login', here: 'claude-mine', source: 'claude-work', differs: true }]);
  });

  it('reads the source’s side under the name the source calls the item, and says not set for what is absent', () => {
    const renamed = both({
      ref: 'modelSets/claude-2',
      sourceRef: 'modelSets/claude',
      kind: 'modelSets',
      fields: ['default'],
    });
    expect(rows(renamed)).toEqual([{ label: 'default', here: null, source: 'opus', differs: true }]);
    expect(rows(both({ ref: 'modelSets/claude', kind: 'modelSets', fields: ['models'] }), HERE, null)).toEqual([
      { label: 'models', here: '["opus"]', source: null, differs: true },
    ]);
  });
});
