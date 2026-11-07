import { describe, it } from 'bun:test';
import { type FleetCloneBundle, FleetCloneBundleSchema } from '@ferretry/protocol';
import should from 'should';
import {
  analyseCloneUpdate,
  cloneBaseFor,
  type CloneUpdateInput,
  describeCloneUpdate,
  planCloneUpdate,
  resolveCloneLogins,
  reviewCloneUpdate,
} from '../../../daemon/lib/account/clone-update.ts';
import {
  applyCloneToBase,
  type CloneBase,
  cloneBaseEntries,
  cloneOriginKeys,
  EMPTY_CLONE_BASE,
} from '../../../daemon/lib/account/clone-base.ts';
import {
  assetReference,
  CloneRefusal,
  movedFile,
  movedFolder,
  pathsOverlap,
} from '../../../daemon/lib/account/clone-parts.ts';
import { COMPONENT_KINDS, parseAccountModel } from '../../../daemon/lib/account/schema.ts';

const KEY_MAIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_PROFILE = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
const KEY_RUNTIME = 'cccccccccccccccccccccccccc';
const KEY_LOGIN = 'dddddddddddddddddddddddddd';
const KEY_NOTES = 'eeeeeeeeeeeeeeeeeeeeeeeeee';
const AT = '2026-10-13T08:00:00.000Z';
const SOURCE = { id: 'daemon-source', name: 'studio-mac', verified: 'browser' as const };
const FROM = { clonedFrom: 'studio-mac', clonedFromDaemon: 'daemon-source' };
const MAIN_PATH = 'components/instructions/main.md';

interface Side {
  readonly main?: string;
  readonly notes?: string;
}

/** The origin keys a bundle carries (a version 1 bundle carries none). */
const keysOf = (bundle: FleetCloneBundle): Record<string, string> => (bundle.version === 2 ? bundle.keys : {});

const bundleOf = (side: Side, extra: Record<string, unknown> = {}): FleetCloneBundle => {
  const instructions: Record<string, unknown> = {};
  const files: { path: string; content: string }[] = [];
  const keys: Record<string, string> = {
    'profile/default': KEY_PROFILE,
    'runtime/claude-default': KEY_RUNTIME,
    'login/claude-you': KEY_LOGIN,
  };
  if (side.main !== undefined) {
    instructions.main = { file: MAIN_PATH };
    files.push({ path: MAIN_PATH, content: side.main });
    keys['instructions/main'] = KEY_MAIN;
  }
  if (side.notes !== undefined) {
    instructions.notes = { file: 'components/instructions/notes.md' };
    files.push({ path: 'components/instructions/notes.md', content: side.notes });
    keys['instructions/notes'] = KEY_NOTES;
  }
  return FleetCloneBundleSchema.parse({
    format: 'ferretry-clone',
    version: 2,
    daemon: SOURCE.id,
    keys,
    machine: 'studio-mac',
    exportedAt: '2026-10-13T07:00:00.000Z',
    credentials: [{ id: 'claude-you', harness: 'claude', label: 'you', email: 'person@example.test' }],
    components: { instructions },
    profiles: { default: { layers: [...(side.main === undefined ? [] : ['instructions/main'])] } },
    runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: false } },
    files,
    notCopied: [],
    ...extra,
  });
};

/** What this machine holds: a copy of main (and notes) carrying the link, with its own content. */
const targetOf = (side: Side, link: Record<string, unknown> = { clonedFromKey: KEY_MAIN }) => {
  const instructions: Record<string, unknown> = {};
  const targetFiles: { path: string; content: string }[] = [];
  if (side.main !== undefined) {
    instructions.main = { file: MAIN_PATH, ...FROM, ...link };
    targetFiles.push({ path: MAIN_PATH, content: side.main });
  }
  if (side.notes !== undefined) {
    instructions.notes = { file: 'components/instructions/notes.md', ...FROM, clonedFromKey: KEY_NOTES };
    targetFiles.push({ path: 'components/instructions/notes.md', content: side.notes });
  }
  const model = parseAccountModel({
    version: 2,
    credentials: {
      'claude-you': { harness: 'claude', store: 'ferretry', label: 'you', ...FROM, clonedFromKey: KEY_LOGIN },
    },
    components: { instructions },
    profiles: {
      default: { layers: Object.keys(instructions).map(name => `instructions/${name}`), clonedFromKey: KEY_PROFILE },
    },
    runtimes: {
      'claude-default': { credential: 'claude-you', profile: 'default', agent: false, clonedFromKey: KEY_RUNTIME },
    },
  });
  return { model, targetFiles };
};

const ROOTS = { userHome: '/person', assetsDirectory: '/state/fleet/assets' };

const baseOf = (side: Side): CloneBase => {
  const bundle = bundleOf(side);
  return applyCloneToBase(EMPTY_CLONE_BASE, {
    source: SOURCE,
    at: AT,
    replace: true,
    copied: cloneBaseEntries(bundle, bundle, new Map([['claude-you', 'claude-you']])),
    sourceKeys: new Set(cloneOriginKeys(bundle).values()),
    model: targetOf(side).model,
  });
};

const inputOf = (
  theirs: Side,
  mine: Side,
  base: Side | undefined,
  patch: Partial<CloneUpdateInput> = {},
): CloneUpdateInput => {
  const here = targetOf(mine);
  return {
    target: here.model,
    bundle: bundleOf(theirs),
    machine: 'work-linux',
    sourceName: 'studio-mac',
    source: SOURCE,
    ...(base === undefined ? {} : { base: baseOf(base).sources[SOURCE.id] }),
    targetFiles: here.targetFiles,
    logins: { matched: new Map([['claude-you', 'claude-you']]), ask: new Map() },
    installed: ['claude', 'codex'],
    existingSkillItems: [],
    existingSecrets: [],
    roots: ROOTS,
    sourceDaemon: SOURCE.id,
    ...patch,
  };
};

const reviewed = (input: CloneUpdateInput) => reviewCloneUpdate(analyseCloneUpdate(input));
const outcomeOf = (input: CloneUpdateInput, ref = 'instructions/main') =>
  reviewed(input).items.find(item => item.ref === ref)?.outcome;

describe('three-way outcomes (design §3)', () => {
  it('should hide an item that is identical on both sides and count it', () => {
    const review = reviewed(inputOf({ main: 'A' }, { main: 'A' }, { main: 'A' }));
    should(review.items).eql([]);
    should(review.same.count).be.aboveOrEqual(1);
    should(review.mode).equal('update');
  });

  it('should call an item changed on the source "theirs" and take it by default', () => {
    const review = reviewed(inputOf({ main: 'B' }, { main: 'A' }, { main: 'A' }));
    const found = review.items.find(item => item.ref === 'instructions/main');
    should(found?.outcome).equal('theirs');
    should(found?.choice).equal('take');
    should(found?.files).eql([{ path: MAIN_PATH, change: 'changed', lines: { added: 1, removed: 1 } }]);
    should(found?.runnable?.reference).equal('instructions/main');
  });

  it('should call an item changed only here "mine" and keep it', () => {
    const found = reviewed(inputOf({ main: 'A' }, { main: 'C' }, { main: 'A' })).items.find(
      item => item.ref === 'instructions/main',
    );
    should(found?.outcome).equal('mine');
    should(found?.choice).equal('keep');
    should(found?.runnable).equal(undefined);
  });

  it('should call an item changed on both sides "both" with NO default choice', () => {
    const found = reviewed(inputOf({ main: 'B' }, { main: 'C' }, { main: 'A' })).items.find(
      item => item.ref === 'instructions/main',
    );
    should(found?.outcome).equal('both');
    should(found?.choice).equal(undefined);
  });

  it('should check "mine equals theirs" before the base: both sides made the same edit', () => {
    should(outcomeOf(inputOf({ main: 'B' }, { main: 'B' }, { main: 'A' }))).equal(undefined);
  });

  it('should call an item the source added "new" and add it by default', () => {
    const found = reviewed(inputOf({ main: 'A', notes: 'N' }, { main: 'A' }, { main: 'A' })).items.find(
      item => item.ref === 'instructions/notes',
    );
    should(found?.outcome).equal('new');
    should(found?.choice).equal('add');
  });

  it('should call a copied item that is gone here "removed-here" and never re-add it by default', () => {
    const found = reviewed(inputOf({ main: 'A', notes: 'N' }, { main: 'A' }, { main: 'A', notes: 'N' })).items.find(
      item => item.ref === 'instructions/notes',
    );
    should(found?.outcome).equal('removed-here');
    should(found?.choice).equal('keep');
    const plan = planCloneUpdate(
      analyseCloneUpdate(inputOf({ main: 'A', notes: 'N' }, { main: 'A' }, { main: 'A', notes: 'N' })),
      { decisions: {} },
    );
    should(plan.model.components.instructions.notes).equal(undefined);
  });

  it('should bring a removed-here item back when ticked', () => {
    const analysis = analyseCloneUpdate(inputOf({ main: 'A', notes: 'N' }, { main: 'A' }, { main: 'A', notes: 'N' }));
    const plan = planCloneUpdate(analysis, { decisions: { 'instructions/notes': 'add' } });
    should(plan.model.components.instructions.notes?.clonedFromKey).equal(KEY_NOTES);
    should(plan.files.map(file => file.path)).eql(['components/instructions/notes.md']);
  });

  it('should call an item the source dropped "gone" and keep it by default', () => {
    const found = reviewed(inputOf({ main: 'A' }, { main: 'A', notes: 'N' }, { main: 'A', notes: 'N' })).items.find(
      item => item.ref === 'instructions/notes',
    );
    should(found?.outcome).equal('gone');
    should(found?.choice).equal('keep');
  });

  it('should refuse to remove a gone item something here still uses', () => {
    const analysis = analyseCloneUpdate(inputOf({ main: 'A' }, { main: 'A', notes: 'N' }, { main: 'A', notes: 'N' }));
    should(() => planCloneUpdate(analysis, { decisions: { 'instructions/notes': 'remove' } })).throw(CloneRefusal);
  });

  it('should settle a kept gone item so it is not offered again', () => {
    const input = inputOf({ main: 'A' }, { main: 'A', notes: 'N' }, { main: 'A', notes: 'N' });
    const analysis = analyseCloneUpdate(input);
    const plan = planCloneUpdate(analysis, { decisions: {} });
    should([...plan.settled]).eql([KEY_NOTES]);
    const record = applyCloneToBase(baseOf({ main: 'A', notes: 'N' }), {
      source: SOURCE,
      at: AT,
      replace: false,
      copied: plan.base,
      sourceKeys: plan.sourceKeys,
      model: plan.model,
      settled: new Set(plan.settled),
    });
    should(record.sources[SOURCE.id]?.items[KEY_NOTES]?.settled).equal(true);
  });
});

describe('both changed', () => {
  const input = inputOf({ main: 'B' }, { main: 'C' }, { main: 'A' });

  it('should refuse an update that leaves a both item unchosen, naming it', () => {
    const analysis = analyseCloneUpdate(input);
    should(() => planCloneUpdate(analysis, { decisions: {} })).throw(/instructions\/main/u);
  });

  it('should take theirs when told to', () => {
    const plan = planCloneUpdate(analyseCloneUpdate(input), { decisions: { 'instructions/main': 'take' } });
    should(plan.files).eql([{ path: MAIN_PATH, content: 'B' }]);
  });

  it('should keep mine when told to, writing nothing', () => {
    const plan = planCloneUpdate(analyseCloneUpdate(input), { decisions: { 'instructions/main': 'keep' } });
    should(plan.files).eql([]);
    should(plan.done.kept).containEql('instructions/main');
  });

  it('should refuse a choice the outcome does not allow', () => {
    should(() => planCloneUpdate(analyseCloneUpdate(input), { decisions: { 'instructions/main': 'remove' } })).throw(
      CloneRefusal,
    );
  });
});

describe('after an apply', () => {
  it('should record theirs as the base for everything the review showed, kept items included', () => {
    const analysis = analyseCloneUpdate(inputOf({ main: 'B' }, { main: 'C' }, { main: 'A' }));
    const plan = planCloneUpdate(analysis, { decisions: { 'instructions/main': 'keep' } });
    const record = applyCloneToBase(baseOf({ main: 'A' }), {
      source: SOURCE,
      at: AT,
      replace: false,
      copied: plan.base,
      sourceKeys: plan.sourceKeys,
      model: plan.model,
    });
    const next = cloneBaseFor(record, SOURCE);
    should(next?.items[KEY_MAIN]?.digest).equal(cloneBaseFor(baseOf({ main: 'B' }), SOURCE)?.items[KEY_MAIN]?.digest);
  });

  it('should ignore a base verified a different way than the source now is', () => {
    should(cloneBaseFor(baseOf({ main: 'A' }), { ...SOURCE, verified: 'self' })).equal(undefined);
  });
});

describe('matching', () => {
  it('should unlink two items that claim one key and say why', () => {
    const mine = targetOf({ main: 'A' });
    const model = parseAccountModel({
      ...mine.model,
      components: {
        instructions: {
          main: { file: MAIN_PATH, ...FROM, clonedFromKey: KEY_MAIN },
          'main-2': { file: MAIN_PATH, ...FROM, clonedFromKey: KEY_MAIN },
        },
      },
    });
    const review = reviewed(inputOf({ main: 'A' }, { main: 'A' }, { main: 'A' }, { target: model }));
    const found = review.items.find(item => item.sourceRef === 'instructions/main');
    should(found?.outcome).equal('new');
    should(found?.choice).equal('skip');
    should(found?.note ?? '').match(/main-2|main/u);
  });

  it('should fall back to name matching when the key here is unknown to the bundle', () => {
    const input = inputOf({ main: 'A' }, { main: 'A' }, undefined, {
      ...targetOf({ main: 'A' }, { clonedFromKey: 'zzzzzzzzzzzzzzzzzzzzzzzzzz' }),
      target: targetOf({ main: 'A' }, { clonedFromKey: 'zzzzzzzzzzzzzzzzzzzzzzzzzz' }).model,
    });
    const review = reviewed(input);
    should(review.items.find(item => item.ref === 'instructions/main')).equal(undefined);
    should(review.same.probable).be.aboveOrEqual(1);
  });

  it('should link by name silently when content is equal, and stamp the key on apply', () => {
    const input = inputOf({ main: 'A' }, { main: 'A' }, undefined, {
      target: targetOf({ main: 'A' }, {}).model,
    });
    const analysis = analyseCloneUpdate(input);
    should(reviewCloneUpdate(analysis).items.find(item => item.ref === 'instructions/main')).equal(undefined);
    const plan = planCloneUpdate(analysis, { decisions: {} });
    should(plan.model.components.instructions.main?.clonedFromKey).equal(KEY_MAIN);
    should(plan.files).eql([]);
  });

  it('should make a differing probable match "both", with the reason', () => {
    const input = inputOf({ main: 'B' }, { main: 'C' }, undefined, { target: targetOf({ main: 'C' }, {}).model });
    const found = reviewed(input).items.find(item => item.ref === 'instructions/main');
    should(found?.outcome).equal('both');
    should(found?.match).equal('probable');
    should(found?.choice).equal(undefined);
    should(found?.note ?? '').match(/probably the same item/iu);
  });

  it('should keep a hand-renamed item linked through its key', () => {
    const input = inputOf({ main: 'B' }, { main: 'A' }, { main: 'A' });
    const renamed = parseAccountModel({
      ...input.target,
      components: { instructions: { renamed: { file: MAIN_PATH, ...FROM, clonedFromKey: KEY_MAIN } } },
      profiles: { default: { layers: ['instructions/renamed'], clonedFromKey: KEY_PROFILE } },
    });
    const found = reviewed({ ...input, target: renamed }).items.find(item => item.sourceRef === 'instructions/main');
    should(found?.ref).equal('instructions/renamed');
    should(found?.outcome).equal('theirs');
    should(found?.match).equal('key');
  });

  it('should treat two name candidates as "new, unticked" and say what it may be', () => {
    const model = parseAccountModel({
      ...targetOf({ main: 'A' }).model,
      components: {
        instructions: {
          main: { file: MAIN_PATH, ...FROM },
          'main-2': { file: 'components/instructions/main-2.md', ...FROM },
        },
      },
    });
    const found = reviewed(
      inputOf({ main: 'A' }, { main: 'A' }, undefined, {
        target: model,
        targetFiles: [
          { path: MAIN_PATH, content: 'A' },
          { path: 'components/instructions/main-2.md', content: 'A' },
        ],
      }),
    ).items.find(item => item.sourceRef === 'instructions/main');
    should(found?.outcome).equal('new');
    should(found?.choice).equal('skip');
    should(found?.note ?? '').match(/may already have this as/u);
  });

  it('should not pair an item that says it came from another machine', () => {
    const model = parseAccountModel({
      version: 2,
      components: {
        instructions: { main: { file: MAIN_PATH, clonedFrom: 'other', clonedFromDaemon: 'daemon-other' } },
      },
    });
    const found = reviewed(
      inputOf({ main: 'A' }, { main: 'A' }, undefined, {
        target: model,
        targetFiles: [{ path: MAIN_PATH, content: 'A' }],
      }),
    ).items.find(item => item.sourceRef === 'instructions/main');
    should(found?.outcome).equal('new');
  });
});

describe('dependencies follow', () => {
  it('should tick a new component a taken profile needs, and refuse unticking it alone', () => {
    const input = inputOf(
      { main: 'A', notes: 'N' },
      { main: 'A' },
      { main: 'A' },
      {
        bundle: bundleOf(
          { main: 'A', notes: 'N' },
          { profiles: { default: { layers: ['instructions/main', 'instructions/notes'] } } },
        ),
      },
    );
    const analysis = analyseCloneUpdate(input);
    const review = reviewCloneUpdate(analysis);
    const profile = review.items.find(item => item.ref === 'profile/default');
    should(profile?.outcome).equal('theirs');
    should(profile?.needs).eql(['instructions/notes']);
    should(review.items.find(item => item.ref === 'instructions/notes')?.choice).equal('add');
    should(() => planCloneUpdate(analysis, { decisions: { 'instructions/notes': 'skip' } })).throw(/needs/u);
    const plan = planCloneUpdate(analysis, { decisions: { 'instructions/notes': 'skip', 'profile/default': 'keep' } });
    should(plan.model.profiles.default?.layers).eql(['instructions/main']);
  });
});

describe('a source the bundle cannot be read from here', () => {
  it('should refuse with a sentence, not a stack', () => {
    const input = inputOf({ main: 'A' }, { main: 'A' }, undefined, {
      bundle: bundleOf({ main: 'A' }, { runtimes: { r: { credential: 'ghost', profile: 'default', agent: false } } }),
    });
    should(() => analyseCloneUpdate(input)).throw(CloneRefusal);
  });
});

describe('partly carried folders', () => {
  const hooksWith = (script: string, carried: boolean) =>
    FleetCloneBundleSchema.parse({
      ...bundleOf({ main: 'A' }),
      components: {
        instructions: { main: { file: MAIN_PATH } },
        hooks: { guard: { harness: 'claude', directory: 'components/hooks/guard' } },
      },
      files: [
        { path: MAIN_PATH, content: 'A' },
        { path: 'components/hooks/guard/a.sh', content: script },
        ...(carried ? [{ path: 'components/hooks/guard/big.sh', content: 'big' }] : []),
      ],
      notCopied: carried ? [] : [{ path: 'components/hooks/guard/big.sh', reason: 'too large' }],
      keys: {
        ...Object.fromEntries(cloneOriginKeys(bundleOf({ main: 'A' }))),
        'hooks/guard': 'ffffffffffffffffffffffffff',
      },
    });

  it('should still show a change to a carried file when another file in the folder could not be carried', () => {
    const base = inputOf({ main: 'A' }, { main: 'A' }, undefined);
    const model = parseAccountModel({
      ...base.target,
      components: {
        instructions: { main: { file: MAIN_PATH, ...FROM, clonedFromKey: KEY_MAIN } },
        hooks: {
          guard: {
            harness: 'claude',
            directory: 'components/hooks/guard',
            ...FROM,
            clonedFromKey: 'ffffffffffffffffffffffffff',
          },
        },
      },
    });
    const found = reviewed({
      ...base,
      bundle: hooksWith('echo new', false),
      target: model,
      targetFiles: [
        { path: MAIN_PATH, content: 'A' },
        { path: 'components/hooks/guard/a.sh', content: 'echo old' },
        { path: 'components/hooks/guard/big.sh', content: 'big' },
      ],
    }).items.find(item => item.ref === 'hooks/guard');
    should(found?.files.map(file => file.path)).eql(['components/hooks/guard/a.sh']);
    should(found?.note ?? '').match(/could not be compared/u);
  });
});

describe('a login is never changed (design §14.4)', () => {
  const SIGNED_IN = {
    harness: 'claude',
    store: 'ferretry',
    label: 'you',
    ...FROM,
    clonedFromKey: KEY_LOGIN,
  };
  const loginsOf = (model: { readonly credentials: object }): string =>
    JSON.stringify(model.credentials['claude-you' as never]);
  const secretsFree = (plan: { readonly files: readonly { readonly path: string }[] }): boolean =>
    plan.files.every(file => file.path.startsWith('components/'));

  it('should leave a matched login byte-identical through an update that rewrites every item', () => {
    const input = inputOf(
      { main: 'B' },
      { main: 'A' },
      { main: 'A' },
      {
        existingSecrets: ['API_TOKEN'],
      },
    );
    const before = loginsOf(input.target);
    const plan = planCloneUpdate(analyseCloneUpdate(input), { decisions: {} });
    should(loginsOf(plan.model)).equal(before);
    should(plan.slots).eql([]);
    should(secretsFree(plan)).equal(true);
  });

  it('should add an empty slot, not touch the login, when the source login matches nothing here', () => {
    const input = inputOf(
      { main: 'B' },
      { main: 'A' },
      { main: 'A' },
      {
        logins: { matched: new Map(), ask: new Map() },
      },
    );
    const before = loginsOf(input.target);
    const plan = planCloneUpdate(analyseCloneUpdate({ ...input, base: undefined }), {
      decisions: { 'runtime/claude-default': 'take', 'instructions/main': 'take' },
    });
    should(loginsOf(plan.model)).equal(before);
    should(plan.slots.length).equal(1);
  });

  it('should leave a signed-in login byte-identical when items are linked by name', () => {
    const input = inputOf({ main: 'A' }, { main: 'A' }, undefined, { target: targetOf({ main: 'A' }, {}).model });
    const before = loginsOf(input.target);
    const plan = planCloneUpdate(analyseCloneUpdate(input), { decisions: {} });
    should(plan.done.linked).containEql('instructions/main');
    should(loginsOf(plan.model)).equal(before);
  });

  it('should leave a login byte-identical whether a gone item is kept or removed', () => {
    const lone = parseAccountModel({
      ...targetOf({ main: 'A', notes: 'N' }).model,
      components: {
        instructions: {
          main: { file: MAIN_PATH, ...FROM, clonedFromKey: KEY_MAIN },
          notes: { file: 'components/instructions/notes.md', ...FROM, clonedFromKey: KEY_NOTES },
        },
      },
      profiles: { default: { layers: ['instructions/main'], clonedFromKey: KEY_PROFILE } },
    });
    const input = inputOf({ main: 'A' }, { main: 'A', notes: 'N' }, { main: 'A', notes: 'N' }, { target: lone });
    const before = loginsOf(input.target);
    for (const choice of ['keep', 'remove'] as const) {
      const plan = planCloneUpdate(analyseCloneUpdate(input), { decisions: { 'instructions/notes': choice } });
      should(loginsOf(plan.model)).equal(before);
    }
  });

  it('should leave the existing login byte-identical through Alongside and Replace', async () => {
    const { planClone } = await import('../../../daemon/lib/account/clone.ts');
    const target = parseAccountModel({
      ...targetOf({ main: 'A' }).model,
      credentials: { 'claude-you': SIGNED_IN },
    });
    const before = loginsOf(target);
    for (const mode of ['alongside', 'replace'] as const) {
      const plan = planClone(target, bundleOf({ main: 'B' }), {
        mode,
        machine: 'work-linux',
        installed: ['claude', 'codex'],
        existingSkillItems: [],
        existingSecrets: ['API_TOKEN'],
        sourceDaemon: SOURCE.id,
      });
      should(loginsOf(plan.model)).equal(before);
    }
  });
});

describe('logins during an update', () => {
  const agentOn = (side: Side = { main: 'A' }) =>
    bundleOf(side, {
      runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: true } },
    });
  const withTwoLogins = () =>
    parseAccountModel({
      ...targetOf({ main: 'A' }).model,
      credentials: {
        'claude-you': { harness: 'claude', store: 'ferretry', label: 'you', ...FROM, clonedFromKey: KEY_LOGIN },
        'claude-two': { harness: 'claude', store: 'ferretry', label: 'two', ...FROM, clonedFromKey: KEY_LOGIN },
        'codex-one': { harness: 'codex', store: 'ferretry', label: 'one' },
      },
    });
  const asking = (patch: Partial<CloneUpdateInput> = {}) =>
    inputOf(
      { main: 'A' },
      { main: 'A' },
      { main: 'A' },
      {
        bundle: agentOn(),
        target: withTwoLogins(),
        logins: { matched: new Map(), ask: new Map([['claude-you', ['claude-two', 'claude-you']]]) },
        ...patch,
      },
    );
  const TAKE = { 'runtime/claude-default': 'take' } as const;

  it('should ask which login when two here claim the source login, and refuse to guess', () => {
    const review = reviewed(asking());
    should(review.logins).eql([{ sourceId: 'claude-you', outcome: 'ask', candidates: ['claude-two', 'claude-you'] }]);
    const refusal = (() => {
      try {
        planCloneUpdate(analyseCloneUpdate(asking()), { decisions: TAKE });
      } catch (error) {
        return error as Error;
      }
      return undefined;
    })();
    should(refusal).be.instanceOf(CloneRefusal);
    should(refusal?.message).containEql('claude-two, claude-you');
  });

  it('should point the runtime at the login the person picked, changing no login', () => {
    const input = asking();
    const before = JSON.stringify(input.target.credentials);
    const plan = planCloneUpdate(analyseCloneUpdate(input), {
      decisions: TAKE,
      logins: { 'claude-you': 'claude-two' },
    });
    should(plan.model.runtimes['claude-default']?.credential).equal('claude-two');
    should(JSON.stringify(plan.model.credentials)).equal(before);
    should(plan.slots).eql([]);
  });

  it('should add an empty slot when the person picked a new one', () => {
    const plan = planCloneUpdate(analyseCloneUpdate(asking()), { decisions: TAKE, logins: { 'claude-you': 'slot' } });
    should(plan.slots.length).equal(1);
    should(Object.keys(plan.model.credentials).length).equal(4);
  });

  it('should refuse a login that is not one of this harness here, or not here at all', () => {
    for (const picked of ['codex-one', 'nobody']) {
      should(() =>
        planCloneUpdate(analyseCloneUpdate(asking()), { decisions: TAKE, logins: { 'claude-you': picked } }),
      ).throw(CloneRefusal);
    }
  });
});

describe('resolving logins from the record and from keys', () => {
  it('should use the login the record paired, else the one carrying the key, else ask, else none', async () => {
    const { resolveCloneLogins } = await import('../../../daemon/lib/account/clone-update.ts');
    const bundle = bundleOf({ main: 'A' });
    const two = parseAccountModel({
      ...targetOf({ main: 'A' }).model,
      credentials: {
        'claude-you': { harness: 'claude', store: 'ferretry', clonedFromKey: KEY_LOGIN },
        'claude-two': { harness: 'claude', store: 'ferretry', clonedFromKey: KEY_LOGIN },
      },
    });
    const paired = baseOf({ main: 'A' }).sources[SOURCE.id];
    should(resolveCloneLogins(bundle, two, paired).matched.get('claude-you')).equal('claude-you');
    should(resolveCloneLogins(bundle, two, undefined).ask.get('claude-you')).eql(['claude-two', 'claude-you']);
    const one = parseAccountModel({
      ...targetOf({ main: 'A' }).model,
    });
    should(resolveCloneLogins(bundle, one, undefined).matched.get('claude-you')).equal('claude-you');
    const none = parseAccountModel({ version: 2 });
    const resolved = resolveCloneLogins(bundle, none, undefined);
    should(resolved.matched.size).equal(0);
    should(resolved.ask.size).equal(0);
    const v1 = resolveCloneLogins({ ...bundle, version: 1 } as never, none, undefined);
    should(v1.matched.size).equal(0);
  });
});

describe('what applying an update says', () => {
  it('should describe the counts, links, runnables, slots and missing parts in words', async () => {
    const { describeCloneUpdate } = await import('../../../daemon/lib/account/clone-update.ts');
    const input = inputOf(
      { main: 'B' },
      { main: 'A' },
      { main: 'A' },
      {
        installed: ['codex'],
        existingSecrets: [],
        logins: { matched: new Map(), ask: new Map() },
      },
    );
    const plan = planCloneUpdate(analyseCloneUpdate(input), {
      decisions: { 'instructions/main': 'take' },
    });
    const lines = describeCloneUpdate(plan, 'work-linux', 'studio-mac');
    should(lines[0]).containEql('Updates work-linux from studio-mac');
    should(lines.join('\n')).containEql('already the same');
    should(lines.join('\n')).containEql('can make work-linux run something');
  });

  it('should list links, paths to check, missing harnesses, missing secrets and kept skills', async () => {
    const { describeCloneUpdate } = await import('../../../daemon/lib/account/clone-update.ts');
    const plan = {
      done: { taken: ['a'], added: [], removed: [], kept: [], linked: ['instructions/main'] },
      same: { count: 2, probable: 1 },
      runnables: [],
      slots: [
        { id: 'claude-you', harness: 'claude', runtimes: ['claude-default'] },
        { id: 'api', harness: 'claude', runtimes: [], environment: true },
      ],
      checkPaths: [{ reference: 'hooks/guard', path: '/home/x/guard.sh' }],
      missingHarnesses: ['claude'],
      missingSecrets: ['API_TOKEN'],
      keptSkillItems: ['review'],
      relocations: [{ reference: 'hooks/a', from: 'components/hooks/a', to: 'components/hooks/a-2' }],
      removals: ['components/hooks/b/gone.sh'],
    };
    const text = describeCloneUpdate(plan as never, 'work-linux', 'studio-mac').join('\n');
    for (const part of [
      'Links 1 item to studio-mac by name',
      'empty login claude-you',
      'Check after copying: hooks/guard names /home/x/guard.sh',
      "claude isn't installed on work-linux",
      'no API_TOKEN',
      'Skill review is already on work-linux',
      'Adds login api on work-linux with the environment configuration the review listed',
      'Writes hooks/a to components/hooks/a-2',
      'Removes 1 file the source no longer has: components/hooks/b/gone.sh',
    ]) {
      should(text).containEql(part);
    }
  });
});

describe('skills folders and files', () => {
  const skillsBundle = (files: { path: string; content: string }[], items = ['review']) => {
    const base = bundleOf({ main: 'A' });
    return FleetCloneBundleSchema.parse({
      ...base,
      components: { ...base.components, skills: { pack: { items } } },
      keys: { ...keysOf(base), 'skills/pack': KEY_NOTES },
      files: [...base.files, ...files],
    });
  };
  const withSkills = (files: { path: string; content: string }[], items = ['review']) => {
    const here = targetOf({ main: 'A' });
    return {
      model: parseAccountModel({
        ...here.model,
        components: {
          ...here.model.components,
          skills: { pack: { items, ...FROM, clonedFromKey: KEY_NOTES } },
        },
      }),
      targetFiles: [...here.targetFiles, ...files],
    };
  };

  it('should list a skill folder file added, changed and removed, and write them on take', () => {
    const mine = withSkills([
      { path: 'skills/review/SKILL.md', content: 'old' },
      { path: 'skills/review/gone.md', content: 'x\ny' },
    ]);
    const input = inputOf({ main: 'A' }, { main: 'A' }, undefined, {
      bundle: skillsBundle([
        { path: 'skills/review/SKILL.md', content: 'new' },
        { path: 'skills/review/fresh.md', content: 'a\nb\nc' },
      ]),
      target: mine.model,
      targetFiles: mine.targetFiles,
    });
    const item = reviewed(input).items.find(entry => entry.ref === 'skills/pack');
    should(item?.files.map(file => `${file.path}:${file.change}`)).eql([
      'skills/review/SKILL.md:changed',
      'skills/review/fresh.md:added',
      'skills/review/gone.md:removed',
    ]);
    const plan = planCloneUpdate(analyseCloneUpdate(input), { decisions: { 'skills/pack': 'take' } });
    should(plan.files.map(file => file.path).toSorted()).eql(['skills/review/SKILL.md', 'skills/review/fresh.md']);
    // What the review said is removed goes with the take.
    should(plan.removals).eql(['skills/review/gone.md']);
  });

  it('should say a skill folder is already here for a new skills component naming an item it has', () => {
    const input = inputOf(
      { main: 'A' },
      { main: 'A' },
      { main: 'A' },
      {
        bundle: skillsBundle([{ path: 'skills/extra/SKILL.md', content: 'e' }], ['extra']),
        existingSkillItems: ['extra'],
      },
    );
    const plan = planCloneUpdate(analyseCloneUpdate(input), { decisions: {} });
    should(plan.keptSkillItems).eql(['extra']);
  });
});

describe('profiles and runtimes new here', () => {
  const bigger = () => {
    const bundle = bundleOf(
      { main: 'A' },
      {
        profiles: {
          default: { layers: ['instructions/main'] },
          second: { layers: ['instructions/main'] },
        },
        runtimes: {
          'claude-default': { credential: 'claude-you', profile: 'default', agent: false },
          'claude-second': { credential: 'claude-you', profile: 'second', agent: true },
        },
      },
    );
    return FleetCloneBundleSchema.parse({
      ...bundle,
      keys: { ...keysOf(bundle), 'profile/second': KEY_NOTES, 'runtime/claude-second': KEY_NOTES.replace(/e/gu, 'f') },
    });
  };

  it('should add a new profile and runtime, pointing the runtime at the login here', () => {
    const input = inputOf({ main: 'A' }, { main: 'A' }, { main: 'A' }, { bundle: bigger() });
    const items = reviewed(input).items;
    should(items.map(item => item.ref).toSorted()).eql(['profile/second', 'runtime/claude-second']);
    const plan = planCloneUpdate(analyseCloneUpdate(input), { decisions: {} });
    should(plan.model.profiles.second?.layers).eql(['instructions/main']);
    should(plan.model.runtimes['claude-second']?.credential).equal('claude-you');
    should(plan.model.runtimes['claude-second']?.agent).equal(true);
  });

  it('should refuse a runtime added without the profile it runs on', () => {
    const input = inputOf({ main: 'A' }, { main: 'A' }, { main: 'A' }, { bundle: bigger() });
    should(() => planCloneUpdate(analyseCloneUpdate(input), { decisions: { 'profile/second': 'skip' } })).throw(
      CloneRefusal,
    );
  });

  it('should refuse a profile added without a layer it needs', () => {
    const bundle = bundleOf(
      { main: 'A', notes: 'N' },
      { profiles: { default: { layers: ['instructions/main', 'instructions/notes'] } } },
    );
    const input = inputOf({ main: 'A' }, { main: 'A' }, { main: 'A' }, { bundle });
    should(() =>
      planCloneUpdate(analyseCloneUpdate(input), {
        decisions: { 'instructions/notes': 'skip', 'profile/default': 'take' },
      }),
    ).throw(CloneRefusal);
  });

  it('should offer a profile that only matches by name, unticked, when its layers differ', () => {
    const bundle = bundleOf(
      { main: 'A', notes: 'N' },
      { profiles: { default: { layers: ['instructions/main', 'instructions/notes'] } } },
    );
    const here = targetOf({ main: 'A' });
    const model = parseAccountModel({
      ...here.model,
      profiles: { default: { layers: ['instructions/main'] } },
      runtimes: {},
    });
    const input = inputOf({ main: 'A' }, { main: 'A' }, undefined, {
      bundle,
      target: model,
      targetFiles: here.targetFiles,
    });
    const item = reviewed(input).items.find(entry => entry.ref === 'profile/default-2');
    should(item?.outcome).equal('new');
    should(item?.note).containEql('You may already have this');
  });

  it('should list a profile the source dropped with the runtimes here that use it', () => {
    const full = bundleOf({ main: 'A' }, { profiles: {}, runtimes: {} });
    const bundle = FleetCloneBundleSchema.parse({
      ...full,
      keys: Object.fromEntries(
        Object.entries(keysOf(full)).filter(([ref]) => !ref.startsWith('profile/') && !ref.startsWith('runtime/')),
      ),
    });
    const input = inputOf({ main: 'A' }, { main: 'A' }, { main: 'A' }, { bundle });
    const item = reviewed(input).items.find(entry => entry.ref === 'profile/default');
    should(item?.outcome).equal('gone');
    should(item?.note).containEql('runtime/claude-default');
  });
});

describe('removed here', () => {
  it('should say a removed item has changed on the source too when the base differs from theirs', () => {
    const input = inputOf({ main: 'B' }, {}, { main: 'A' });
    const item = reviewed(input).items.find(entry => entry.ref === 'instructions/main');
    should(item?.outcome).equal('removed-here');
    should(item?.note).containEql('changed on the source too');
  });

  it('should tick a removed-here item a new profile needs', () => {
    const bundle = bundleOf(
      { main: 'A', notes: 'N' },
      { profiles: { default: { layers: ['instructions/main'] }, extra: { layers: ['instructions/notes'] } } },
    );
    const here = targetOf({ main: 'A' });
    const model = parseAccountModel({
      ...here.model,
      profiles: { default: { layers: ['instructions/main'], clonedFromKey: KEY_PROFILE } },
    });
    const base = baseOf({ main: 'A', notes: 'N' }).sources[SOURCE.id];
    const input = inputOf({ main: 'A', notes: 'N' }, { main: 'A' }, undefined, {
      bundle,
      target: model,
      targetFiles: here.targetFiles,
      base,
    });
    const plan = planCloneUpdate(analyseCloneUpdate(input), { decisions: { 'profile/extra': 'add' } });
    should(plan.model.components.instructions.notes).not.be.undefined();
  });
});

describe('the review the apply names', () => {
  it('should name the same review for the same input, and another one for another input', () => {
    const analysis = analyseCloneUpdate(inputOf({ main: 'B' }, { main: 'A' }, { main: 'A' }));
    const again = analyseCloneUpdate(inputOf({ main: 'B' }, { main: 'A' }, { main: 'A' }));
    const other = analyseCloneUpdate(inputOf({ main: 'C' }, { main: 'A' }, { main: 'A' }));
    should(again.fingerprint).equal(analysis.fingerprint);
    should(other.fingerprint).not.equal(analysis.fingerprint);
  });
});

describe('what else a copy can carry', () => {
  const KEY_A = 'gggggggggggggggggggggggggg';
  const KEY_B = 'hhhhhhhhhhhhhhhhhhhhhhhhhh';
  const withKeys = (bundle: FleetCloneBundle, keys: Record<string, string>) =>
    FleetCloneBundleSchema.parse({ ...bundle, keys: { ...keysOf(bundle), ...keys } });

  it('should refuse an update that would leave two profiles layering each other', () => {
    const shape = (a: string) => ({
      profiles: { a: { layers: [a] }, b: { layers: ['instructions/main'] } },
      runtimes: {},
    });
    const keys = { 'profile/a': KEY_A, 'profile/b': KEY_B };
    const old = withKeys(
      bundleOf(
        { main: 'A' },
        { profiles: { a: { layers: ['instructions/main'] }, b: { layers: ['instructions/main'] } }, runtimes: {} },
      ),
      keys,
    );
    const base = applyCloneToBase(EMPTY_CLONE_BASE, {
      source: SOURCE,
      at: AT,
      replace: true,
      copied: cloneBaseEntries(old, old, new Map()),
      sourceKeys: new Set(cloneOriginKeys(old).values()),
      model: parseAccountModel({
        ...targetOf({ main: 'A' }).model,
        profiles: {
          a: { layers: ['instructions/main'], clonedFromKey: KEY_A },
          b: { layers: ['instructions/main'], clonedFromKey: KEY_B },
        },
        runtimes: {},
      }),
    });
    const here = targetOf({ main: 'A' });
    const input = inputOf({ main: 'A' }, { main: 'A' }, undefined, {
      bundle: withKeys(bundleOf({ main: 'A' }, shape('profile/b')), keys),
      target: parseAccountModel({
        ...here.model,
        profiles: {
          a: { layers: ['instructions/main'], clonedFromKey: KEY_A },
          b: { layers: ['profile/a'], clonedFromKey: KEY_B },
        },
        runtimes: {},
      }),
      targetFiles: here.targetFiles,
      base: base.sources[SOURCE.id],
    });
    should(() => planCloneUpdate(analyseCloneUpdate(input), { decisions: {} })).throw(/cannot read/u);
  });

  it('should write a hooks folder and name the secrets a new server needs', () => {
    const bundle = withKeys(
      bundleOf(
        { main: 'A' },
        {
          components: {
            instructions: { main: { file: MAIN_PATH } },
            hooks: { guard: { harness: 'claude', directory: 'components/hooks/guard' } },
            mcp: { notes: { command: 'notes', env: { TOKEN: '${secret:API_TOKEN}' } } },
          },
          files: [
            { path: MAIN_PATH, content: 'A' },
            { path: 'components/hooks/guard/run.sh', content: 'echo hi' },
          ],
        },
      ),
      { 'hooks/guard': KEY_A, 'mcp/notes': KEY_B },
    );
    const input = inputOf({ main: 'A' }, { main: 'A' }, { main: 'A' }, { bundle });
    const plan = planCloneUpdate(analyseCloneUpdate(input), { decisions: {} });
    should(plan.files.map(file => file.path)).containEql('components/hooks/guard/run.sh');
    should(plan.missingSecrets).eql(['API_TOKEN']);
    should(plan.model.components.hooks.guard?.directory).equal('components/hooks/guard');
  });

  it('should write over a hooks folder that is already here in the folder it has', () => {
    const here = targetOf({ main: 'A' });
    const model = parseAccountModel({
      ...here.model,
      components: {
        instructions: { main: { file: MAIN_PATH, ...FROM, clonedFromKey: KEY_MAIN } },
        hooks: { guard: { harness: 'claude', directory: 'components/hooks/mine', ...FROM, clonedFromKey: KEY_A } },
      },
    });
    const bundle = withKeys(
      bundleOf(
        { main: 'A' },
        {
          components: {
            instructions: { main: { file: MAIN_PATH } },
            hooks: { guard: { harness: 'claude', directory: 'components/hooks/guard' } },
          },
          files: [
            { path: MAIN_PATH, content: 'A' },
            { path: 'components/hooks/guard/run.sh', content: 'new' },
          ],
        },
      ),
      { 'hooks/guard': KEY_A },
    );
    const input = inputOf({ main: 'A' }, { main: 'A' }, undefined, {
      bundle,
      target: model,
      targetFiles: [...here.targetFiles, { path: 'components/hooks/mine/run.sh', content: 'old' }],
    });
    const plan = planCloneUpdate(analyseCloneUpdate(input), { decisions: { 'hooks/guard': 'take' } });
    should(plan.model.components.hooks.guard?.directory).equal('components/hooks/mine');
  });

  it('should copy an environment login as its own login and never touch one that exists', () => {
    const bundle = FleetCloneBundleSchema.parse({
      ...bundleOf({ main: 'A' }),
      credentials: [
        {
          id: 'claude-you',
          harness: 'claude',
          store: 'environment',
          env: { ANTHROPIC_API_KEY: '${secret:API_TOKEN}' },
        },
      ],
    });
    const input = inputOf({ main: 'A' }, { main: 'A' }, undefined, {
      bundle,
      target: parseAccountModel({ ...targetOf({ main: 'A' }).model, runtimes: {} }),
      logins: { matched: new Map(), ask: new Map() },
    });
    const plan = planCloneUpdate(analyseCloneUpdate(input), { decisions: {} });
    should(plan.slots.length).equal(1);
    should(plan.model.credentials['claude-you']).not.be.undefined();
  });

  it('should treat an item that names this source by machine alone as one it dropped', () => {
    const here = targetOf({ main: 'A' });
    const model = parseAccountModel({
      ...here.model,
      components: {
        instructions: {
          main: { file: MAIN_PATH, ...FROM, clonedFromKey: KEY_MAIN },
          old: { file: 'components/instructions/old.md', clonedFrom: 'studio-mac', clonedFromKey: KEY_NOTES },
        },
      },
    });
    const input = inputOf(
      { main: 'A' },
      { main: 'A' },
      { main: 'A' },
      {
        target: model,
        targetFiles: [...here.targetFiles, { path: 'components/instructions/old.md', content: 'o' }],
      },
    );
    should(outcomeOf(input, 'instructions/old')).equal('gone');
  });
});

describe('linking a profile and a runtime by name', () => {
  it('should stamp only the key on a profile and runtime, never where they came from', () => {
    const here = targetOf({ main: 'A' });
    const model = parseAccountModel({
      ...here.model,
      profiles: { default: { layers: ['instructions/main'] } },
      runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: false } },
    });
    const input = inputOf({ main: 'A' }, { main: 'A' }, undefined, { target: model, targetFiles: here.targetFiles });
    const plan = planCloneUpdate(analyseCloneUpdate(input), { decisions: {} });
    should(plan.model.profiles.default).eql({ layers: ['instructions/main'], clonedFromKey: KEY_PROFILE });
    should(plan.model.runtimes['claude-default']?.clonedFromKey).equal(KEY_RUNTIME);
    should(plan.model.runtimes['claude-default']).not.have.property('clonedFrom');
  });
});

// ── Security review regressions (#F544) ──────────────────────────────────────────────────────────

const KEY_A = 'ffffffffffffffffffffffffff';
const KEY_B = 'gggggggggggggggggggggggggg';
const KEY_API = 'hhhhhhhhhhhhhhhhhhhhhhhhhh';

/** A version 2 bundle from the source with nothing in it but what the test names. */
const sourceBundle = (patch: Record<string, unknown> = {}): FleetCloneBundle =>
  FleetCloneBundleSchema.parse({
    format: 'ferretry-clone',
    version: 2,
    daemon: SOURCE.id,
    keys: {},
    machine: 'studio-mac',
    exportedAt: AT,
    credentials: [],
    components: {},
    profiles: {},
    runtimes: {},
    files: [],
    notCopied: [],
    ...patch,
  });

/** An update of an otherwise empty machine (or `target`) from `bundle`, with no record. */
const bareInput = (
  bundle: FleetCloneBundle,
  target = parseAccountModel({ version: 2 }),
  targetFiles: { path: string; content: string }[] = [],
  patch: Partial<CloneUpdateInput> = {},
): CloneUpdateInput => ({
  target,
  bundle,
  machine: 'work-linux',
  sourceName: 'studio-mac',
  source: SOURCE,
  targetFiles,
  logins: resolveCloneLogins(bundle, target, undefined),
  installed: ['claude', 'codex'],
  existingSkillItems: [],
  existingSecrets: [],
  roots: ROOTS,
  sourceDaemon: SOURCE.id,
  ...patch,
});

const hooksAt = (directory: string, key: string) => ({ harness: 'claude', directory, ...FROM, clonedFromKey: key });

describe('a taken item never writes a path another item here uses (#F544 finding 1)', () => {
  const twoHooks = (aDirectory = 'components/hooks/a') =>
    sourceBundle({
      keys: { 'hooks/a': KEY_A, 'hooks/b': KEY_B },
      components: {
        hooks: {
          a: { harness: 'claude', directory: aDirectory },
          b: { harness: 'claude', directory: 'components/hooks/b' },
        },
      },
      files: [
        { path: `${aDirectory}/run.sh`, content: 'new' },
        { path: 'components/hooks/b/run.sh', content: 'old' },
      ],
    });
  const sharing = parseAccountModel({
    version: 2,
    components: {
      hooks: { a: hooksAt('components/hooks/shared', KEY_A), b: hooksAt('components/hooks/shared', KEY_B) },
    },
  });
  const shared = [{ path: 'components/hooks/shared/run.sh', content: 'old' }];

  it('should move a taken folder off a path an item hidden as the same uses, and say where it lands', () => {
    // Arrange
    const analysis = analyseCloneUpdate(bareInput(twoHooks(), sharing, shared));

    // Act
    const review = reviewCloneUpdate(analysis);
    const plan = planCloneUpdate(analysis, { decisions: { 'hooks/a': 'take' } });

    // Assert: b is the same and hidden; a lands in a folder of its own; b's script is untouched.
    should(review.items.map(item => item.ref)).eql(['hooks/a']);
    should(review.items[0]?.files).eql([
      { path: 'components/hooks/a/run.sh', change: 'added', lines: { added: 1, removed: 0 } },
    ]);
    should(review.items[0]?.note).containEql(
      'components/hooks/shared is also used by hooks/b here, so taking this writes it to components/hooks/a',
    );
    should(plan.files).eql([{ path: 'components/hooks/a/run.sh', content: 'new' }]);
    should(plan.model.components.hooks.a?.directory).equal('components/hooks/a');
    should(plan.model.components.hooks.b?.directory).equal('components/hooks/shared');
    should(plan.relocations).eql([{ reference: 'hooks/a', from: 'components/hooks/a', to: 'components/hooks/a' }]);
    should(plan.removals).eql([]);
  });

  it('should pick a fresh folder when the source path itself is the shared one', () => {
    const analysis = analyseCloneUpdate(bareInput(twoHooks('components/hooks/shared'), sharing, shared));
    const plan = planCloneUpdate(analysis, { decisions: { 'hooks/a': 'take' } });
    should(plan.files).eql([{ path: 'components/hooks/shared-2/run.sh', content: 'new' }]);
    should(plan.model.components.hooks.a?.directory).equal('components/hooks/shared-2');
  });

  it('should move a taken document off a file an item kept here uses too', () => {
    // Arrange: two instructions share one document here; both changed with no record, so both are "both".
    const bundle = sourceBundle({
      keys: { 'instructions/x': KEY_A, 'instructions/y': KEY_B },
      components: {
        instructions: { x: { file: 'components/instructions/x.md' }, y: { file: 'components/instructions/y.md' } },
      },
      files: [
        { path: 'components/instructions/x.md', content: 'x from the source' },
        { path: 'components/instructions/y.md', content: 'y from the source' },
      ],
    });
    const target = parseAccountModel({
      version: 2,
      components: {
        instructions: {
          x: { file: 'components/instructions/shared.md', ...FROM, clonedFromKey: KEY_A },
          y: { file: 'components/instructions/shared.md', ...FROM, clonedFromKey: KEY_B },
        },
      },
    });
    const analysis = analyseCloneUpdate(
      bareInput(bundle, target, [{ path: 'components/instructions/shared.md', content: 'mine' }]),
    );

    // Act
    const plan = planCloneUpdate(analysis, { decisions: { 'instructions/x': 'take', 'instructions/y': 'keep' } });

    // Assert
    should(plan.files).eql([{ path: 'components/instructions/x.md', content: 'x from the source' }]);
    should(plan.model.components.instructions.x?.file).equal('components/instructions/x.md');
    should(plan.model.components.instructions.y?.file).equal('components/instructions/shared.md');
  });

  it('should move a taken folder that holds another item document, and a document inside another folder', () => {
    // Arrange: hooks/h owns components/shared; instructions/i lives inside it.
    const bundle = sourceBundle({
      keys: { 'hooks/h': KEY_A, 'instructions/i': KEY_B },
      components: {
        hooks: { h: { harness: 'claude', directory: 'components/hooks/h' } },
        instructions: { i: { file: 'components/instructions/i.md' } },
      },
      files: [
        { path: 'components/hooks/h/run.sh', content: 'run' },
        { path: 'components/instructions/i.md', content: 'read me' },
      ],
    });
    const target = parseAccountModel({
      version: 2,
      components: {
        hooks: { h: hooksAt('components/shared', KEY_A) },
        instructions: { i: { file: 'components/shared/README.md', ...FROM, clonedFromKey: KEY_B } },
      },
    });
    const analysis = analyseCloneUpdate(
      bareInput(bundle, target, [
        { path: 'components/shared/run.sh', content: 'old run' },
        { path: 'components/shared/README.md', content: 'old read me' },
      ]),
    );

    // Act
    const plan = planCloneUpdate(analysis, { decisions: { 'hooks/h': 'take', 'instructions/i': 'take' } });

    // Assert: nothing lands under the shared folder, and neither removes the other's file.
    should(plan.files.map(file => file.path).toSorted()).eql([
      'components/hooks/h/run.sh',
      'components/instructions/i.md',
    ]);
    should(plan.removals).eql([]);
  });

  it('should leave a skill item another item here lists as it is, listing it as kept', () => {
    // Arrange: the source's pack changed review; a local pack here lists review too.
    const bundle = sourceBundle({
      keys: { 'skills/pack': KEY_A },
      components: { skills: { pack: { items: ['review', 'own'] } } },
      files: [
        { path: 'skills/review/SKILL.md', content: 'new' },
        { path: 'skills/own/SKILL.md', content: 'own, changed' },
      ],
    });
    const target = parseAccountModel({
      version: 2,
      components: {
        skills: { pack: { items: ['review', 'own'], ...FROM, clonedFromKey: KEY_A }, local: { items: ['review'] } },
      },
    });
    const analysis = analyseCloneUpdate(
      bareInput(bundle, target, [
        { path: 'skills/review/SKILL.md', content: 'old' },
        { path: 'skills/review/mine.md', content: 'local' },
        { path: 'skills/own/SKILL.md', content: 'own' },
      ]),
    );

    // Act
    const item = reviewCloneUpdate(analysis).items.find(entry => entry.ref === 'skills/pack');
    const plan = planCloneUpdate(analysis, { decisions: { 'skills/pack': 'take' } });

    // Assert
    should(item?.note).containEql('Skill review is also used by skills/local here, so it stays as it is.');
    should(item?.files.map(file => file.path)).eql(['skills/own/SKILL.md']);
    should(plan.files).eql([{ path: 'skills/own/SKILL.md', content: 'own, changed' }]);
    should(plan.keptSkillItems).eql(['review']);
    should(plan.removals).eql([]);
  });
});

describe('a moved path respects folder ownership both ways (#F544 finding 1, ancestors)', () => {
  const folder = 'components/shared';
  const readme = `${folder}/README.md`;
  const sourceOf = (readmeContent: string) =>
    sourceBundle({
      keys: { 'hooks/h': KEY_A, 'instructions/i': KEY_B },
      components: {
        hooks: { h: { harness: 'claude', directory: 'components/hooks/h' } },
        instructions: { i: { file: readme } },
      },
      files: [
        { path: 'components/hooks/h/run.sh', content: 'run' },
        { path: readme, content: readmeContent },
      ],
    });
  const targetWith = (hookDirectory = folder) =>
    parseAccountModel({
      version: 2,
      components: {
        hooks: { h: hooksAt(hookDirectory, KEY_A) },
        instructions: { i: { file: readme, ...FROM, clonedFromKey: KEY_B } },
      },
    });

  it.each([
    ['hidden as the same', 'run', {}],
    ['kept after a both-changed review', 'edited', { 'hooks/h': 'keep' as const }],
  ])('should land a taken document outside a hook folder here that is %s', (_name, mine, extra) => {
    // Arrange: the hook folder is components/shared; the taken document's path sits inside it.
    const bundle = sourceOf('new');
    const analysis = analyseCloneUpdate(bareInput(bundle, targetWith(), [{ path: `${folder}/run.sh`, content: mine }]));

    // Act
    const plan = planCloneUpdate(analysis, { decisions: { 'instructions/i': 'take', ...extra } });

    // Assert: nothing is written inside the folder, and the hook's bytes and folder are as they were.
    const written = plan.files.map(file => file.path);
    should(written.some(path => path === folder || path.startsWith(`${folder}/`))).be.false();
    should(written).containEql('components/shared-2/README.md');
    should(plan.model.components.instructions.i?.file).equal('components/shared-2/README.md');
    should(plan.model.components.hooks.h?.directory).equal(folder);
    should(plan.removals).eql([]);
  });

  it('should land a taken document outside a hook folder here that has changed here since the last copy', () => {
    // Arrange: the record says the hook folder was run; here it is edited, and the source did not change it.
    const old = sourceOf('old');
    const base = applyCloneToBase(EMPTY_CLONE_BASE, {
      source: SOURCE,
      at: AT,
      replace: true,
      copied: cloneBaseEntries(old, old, new Map()),
      sourceKeys: new Set(cloneOriginKeys(old).values()),
      model: targetWith(),
    });
    const bundle = sourceOf('newer');
    const analysis = analyseCloneUpdate(
      bareInput(bundle, targetWith(), [{ path: `${folder}/run.sh`, content: 'edited here' }], {
        base: base.sources[SOURCE.id],
      }),
    );

    // Act
    const plan = planCloneUpdate(analysis, { decisions: { 'instructions/i': 'take' } });

    // Assert
    should(plan.files.map(file => file.path)).eql(['components/shared-2/README.md']);
    should(plan.model.components.hooks.h?.directory).equal(folder);
  });

  it('should land a new folder beside a document another item here owns, never over it', () => {
    // Arrange: an item here owns components/shared/README.md; the source's new hook wants components/shared.
    const bundle = sourceBundle({
      keys: { 'hooks/n': KEY_A },
      components: { hooks: { n: { harness: 'claude', directory: folder } } },
      files: [{ path: `${folder}/run.sh`, content: 'run' }],
    });
    const target = parseAccountModel({
      version: 2,
      components: { instructions: { own: { file: readme } } },
    });
    const analysis = analyseCloneUpdate(bareInput(bundle, target, [{ path: readme, content: 'mine' }]));

    // Act
    const plan = planCloneUpdate(analysis, { decisions: { 'hooks/n': 'add' } });

    // Assert
    should(plan.model.components.hooks.n?.directory).equal('components/shared-2');
    should(plan.files).eql([{ path: 'components/shared-2/run.sh', content: 'run' }]);
    should(plan.model.components.instructions.own?.file).equal(readme);
  });
});

describe('movedFile and movedFolder choose a destination no owned path touches', () => {
  const none = new Set<string>();

  it('should leave a free folder where it is and keep a free document on its renamed stem', () => {
    should(movedFolder('components/hooks/a', 'a', 'b', none)).equal('components/hooks/a');
    should(movedFile('components/instructions/a.md', 'a', 'b', none)).equal('components/instructions/b.md');
  });

  it('should refuse an exact file collision with a numbered sibling', () => {
    const used = new Set(['components/instructions/x.md']);
    should(movedFile('components/instructions/x.md', 'x', 'x', used)).equal('components/instructions/x-2.md');
  });

  it('should step a document out of an owned folder, not number it inside', () => {
    const used = new Set(['components/shared']);
    should(movedFile(`components/shared/README.md`, 'README', 'README', used)).equal('components/shared-2/README.md');
  });

  it('should step out beside the outermost owned folder and skip names already taken', () => {
    const used = new Set(['components/shared', 'components/shared-2', 'components/shared/deep']);
    should(movedFile('components/shared/deep/a.md', 'a', 'a', used)).equal('components/shared-3/deep/a.md');
    should(movedFolder('components/shared/deep/x', 'x', 'x', used)).equal('components/shared-3/deep/x');
  });

  it('should not number a document into the folder that holds a file it would cover', () => {
    // A document named like an owned folder is renumbered; it is never an ancestor of an owned path.
    const used = new Set(['components/shared/run.sh']);
    should(movedFile('components/shared', 'shared', 'shared', used)).equal('components/shared-2');
  });

  it('should number a folder that would cover an owned document', () => {
    const used = new Set(['components/shared/README.md']);
    should(movedFolder('components/shared', 'shared', 'shared', used)).equal('components/shared-2');
  });
});

describe('an owner reached through an alias is the same owner (#F544 finding 1, aliases)', () => {
  const shared = 'components/hooks/shared';
  // b lives outside the setup folder on both machines, so the source cannot carry it and says so.
  const twoHooks = (alias: string) =>
    sourceBundle({
      keys: { 'hooks/a': KEY_A, 'hooks/b': KEY_B },
      components: {
        hooks: {
          a: { harness: 'claude', directory: 'components/hooks/a' },
          b: { harness: 'claude', directory: alias },
        },
      },
      files: [{ path: 'components/hooks/a/run.sh', content: 'new' }],
      notCopied: [{ path: alias, reason: 'outside the setup folder' }],
    });
  const withAlias = (alias: string) =>
    parseAccountModel({
      version: 2,
      components: { hooks: { a: hooksAt(shared, KEY_A), b: hooksAt(alias, KEY_B) } },
    });
  const filesAt = (...spellings: string[]) => [
    ...spellings.map(spelling => ({ path: `${spelling}/run.sh`, content: 'old' })),
    { path: `${shared}/gone.sh`, content: 'b still runs this' },
  ];

  it.each([
    ['an absolute alias', '/state/fleet/assets/components/hooks/shared', ROOTS],
    [
      'a ~/ alias',
      '~/fleet/assets/components/hooks/shared',
      { userHome: '/state', assetsDirectory: '/state/fleet/assets' },
    ],
    [
      'a $HOME/ alias',
      '$HOME/fleet/assets/components/hooks/shared',
      { userHome: '/state', assetsDirectory: '/state/fleet/assets' },
    ],
  ])('should not write the folder an item here owns through %s', (_name, alias, roots) => {
    // Arrange: b names the folder a also uses, only by another spelling; b is the same and so hidden.
    const analysis = analyseCloneUpdate(
      bareInput(twoHooks(alias), withAlias(alias), filesAt(shared, alias), { roots }),
    );

    // Act
    const review = reviewCloneUpdate(analysis);
    const plan = planCloneUpdate(analysis, { decisions: { 'hooks/a': 'take' } });

    // Assert: a lands in a folder of its own; the owner's bytes, files and declaration are as they were.
    should(review.items.map(item => item.ref)).eql(['hooks/a']);
    should(plan.files.map(file => file.path)).eql(['components/hooks/a/run.sh']);
    should(plan.removals).eql([]);
    should(plan.model.components.hooks.b?.directory).equal(alias);
    should(plan.model.components.hooks.a?.directory).equal('components/hooks/a');
    should(review.items[0]?.note).containEql('is also used by hooks/b here');
  });

  it('should bind the review to the alias, so a changed spelling is a different review', () => {
    const absolute = '/state/fleet/assets/components/hooks/shared';
    const reviewed = analyseCloneUpdate(bareInput(twoHooks(absolute), withAlias(absolute), filesAt(shared, absolute)));
    const changed = analyseCloneUpdate(
      bareInput(twoHooks(absolute), withAlias('components/hooks/other'), [
        { path: 'components/hooks/shared/run.sh', content: 'old' },
        { path: 'components/hooks/other/run.sh', content: 'old' },
      ]),
    );
    should(changed.fingerprint).not.equal(reviewed.fingerprint);
  });

  it('should keep an alias outside the asset tree out of the ownership', () => {
    should(assetReference('/elsewhere/components/hooks/shared', ROOTS)).be.undefined();
    should(assetReference('/state/fleet/assets/../secret', ROOTS)).be.undefined();
    should(assetReference('../secret', ROOTS)).be.undefined();
    should(assetReference('..', ROOTS)).be.undefined();
    should(assetReference('~other/components/x', ROOTS)).be.undefined();
    should(assetReference('$OTHER/components/x', ROOTS)).be.undefined();
    should(assetReference('$HOMEWARD/components/x', ROOTS)).be.undefined();
    should(assetReference('/state/fleet/assets/components/x/', ROOTS)).equal('components/x');
    should(assetReference('./components/x', ROOTS)).equal('components/x');
  });

  it('should read a relative path that steps out and back in as the folder it reaches, as expandAssetPath does', () => {
    should(assetReference('../assets/components/hooks/shared', ROOTS)).equal('components/hooks/shared');
    should(assetReference('components/hooks/x/../shared/', ROOTS)).equal('components/hooks/shared');
    should(assetReference('/state/fleet/assets/components/x/../y', ROOTS)).equal('components/y');
  });

  it('should read every spelling of the asset tree itself as the one root, an ancestor of every path', () => {
    const home = { userHome: '/state', assetsDirectory: '/state/fleet/assets' };
    for (const spelling of ['/state/fleet/assets', '/state/fleet/assets/', '.', './', '../assets', 'components/..']) {
      should(assetReference(spelling, ROOTS)).equal('.');
    }
    should(assetReference('~/fleet/assets', home)).equal('.');
    should(assetReference('$HOME/fleet/assets/', home)).equal('.');
    should(pathsOverlap('.', 'components/hooks/a/run.sh')).be.true();
    should(pathsOverlap('skills/x', '.')).be.true();
    should(pathsOverlap('components/hooks/a', 'components/hooks/b')).be.false();
  });
});

describe('an owner of the whole asset tree, or reached by stepping out and back (#F575 finding 1)', () => {
  const shared = 'components/hooks/shared';
  const home = { userHome: '/state', assetsDirectory: '/state/fleet/assets' };
  /** a is taken; b is the owner the take must leave as it was. b's source lives outside the setup folder. */
  const twoHooks = (alias: string, harness = 'claude') => {
    const theirs = alias.startsWith('/') ? alias : '/elsewhere/hooks/b';
    return sourceBundle({
      keys: { 'hooks/a': KEY_A, 'hooks/b': KEY_B },
      components: {
        hooks: {
          a: { harness: 'claude', directory: 'components/hooks/a' },
          b: { harness, directory: theirs },
        },
      },
      files: [{ path: 'components/hooks/a/run.sh', content: 'new' }],
      notCopied: [{ path: theirs, reason: 'outside the setup folder' }],
    });
  };
  const withOwner = (alias: string) =>
    parseAccountModel({
      version: 2,
      components: { hooks: { a: hooksAt(shared, KEY_A), b: hooksAt(alias, KEY_B) } },
    });
  const here = [
    { path: `${shared}/run.sh`, content: 'old' },
    { path: `${shared}/gone.sh`, content: 'b still runs this' },
  ];

  it.each([
    ['the absolute asset tree, hidden as the same', '/state/fleet/assets', 'claude', ROOTS, {}],
    ['the absolute asset tree, kept', '/state/fleet/assets/', 'codex', ROOTS, { 'hooks/b': 'keep' as const }],
    ['the relative root ., kept', '.', 'codex', ROOTS, { 'hooks/b': 'keep' as const }],
    ['a ~/ spelling of the asset tree, kept', '~/fleet/assets', 'codex', home, { 'hooks/b': 'keep' as const }],
  ])('should refuse a take that would write inside %s another item owns', (_name, alias, harness, roots, kept) => {
    // Arrange
    const analysis = analyseCloneUpdate(bareInput(twoHooks(alias, harness), withOwner(alias), here, { roots }));
    const review = reviewCloneUpdate(analysis);

    // Act + Assert: the take is refused, saying who owns the tree; nothing is chosen into the refusal.
    should(review.items.find(item => item.ref === 'hooks/a')?.note).containEql(
      'hooks/b here uses the whole setup folder, so writing components/hooks/a would change it too',
    );
    should(() => planCloneUpdate(analysis, { decisions: { 'hooks/a': 'take', ...kept } })).throw(CloneRefusal, {
      message: /hooks\/b here uses the whole setup folder/u,
    });
    const left = planCloneUpdate(analysis, { decisions: { 'hooks/a': 'keep', ...kept } });
    should(left.files).eql([]);
    should(left.removals).eql([]);
    should(left.model.components.hooks.b?.directory).equal(alias);
    should(left.model.components.hooks.a?.directory).equal(shared);
  });

  it('should leave out by default a new profile that needs a refused write, rather than choose it into a refusal', () => {
    // Arrange: the new profile layers the new hook c, which cannot be written while b owns the tree.
    const bundle = sourceBundle({
      keys: { 'hooks/c': KEY_A, 'profile/p': KEY_API },
      components: { hooks: { c: { harness: 'claude', directory: 'components/hooks/c' } } },
      profiles: { p: { layers: ['hooks/c'] } },
      files: [{ path: 'components/hooks/c/run.sh', content: 'new' }],
    });
    const target = parseAccountModel({ version: 2, components: { hooks: { b: hooksAt('.', KEY_B) } } });
    const analysis = analyseCloneUpdate(bareInput(bundle, target, here));

    // Act
    const plan = planCloneUpdate(analysis, { decisions: {} });

    // Assert
    should(analysis.defaults.get('hooks/c')).equal('skip');
    should(analysis.defaults.get('profile/p')).equal('skip');
    should(plan.files).eql([]);
    should(plan.model.profiles.p).be.undefined();
  });

  describe('default propagation through a dependency chain whose end cannot be written', () => {
    const KEY_P = 'iiiiiiiiiiiiiiiiiiiiiiiiii';
    const KEY_Q = 'jjjjjjjjjjjjjjjjjjjjjjjjjj';
    const KEY_R = 'kkkkkkkkkkkkkkkkkkkkkkkkkk';
    const owner = parseAccountModel({ version: 2, components: { hooks: { b: hooksAt('.', KEY_B) } } });
    const hookC = { hooks: { c: { harness: 'claude', directory: 'components/hooks/c' } } };
    const fileC = [{ path: 'components/hooks/c/run.sh', content: 'new' }];
    const chain = (target = owner, direct = true) => {
      const bundle = sourceBundle({
        keys: { 'hooks/c': KEY_A, 'profile/p': KEY_P, 'profile/q': KEY_Q, 'runtime/r': KEY_R },
        credentials: [{ id: 'api', harness: 'claude' }],
        components: hookC,
        files: fileC,
        profiles: { p: { layers: ['hooks/c'] }, q: { layers: ['profile/p'] } },
        runtimes: { r: { credential: 'api', profile: direct ? 'p' : 'q', agent: true } },
      });
      return analyseCloneUpdate(bareInput(bundle, target, here));
    };
    const reason = /hooks\/b here uses the whole setup folder/u;

    it('should return, and leave out the runtime, its profile and the blocked hook, by default', () => {
      // Arrange + Act: runtime r -> profile p -> hook c, which cannot be written while b owns the tree.
      const analysis = chain();
      const plan = planCloneUpdate(analysis, { decisions: {} });

      // Assert
      should(analysis.defaults.get('hooks/c')).equal('skip');
      should(analysis.defaults.get('profile/p')).equal('skip');
      should(analysis.defaults.get('runtime/r')).equal('skip');
      should(plan.files).eql([]);
      should(plan.model.profiles.p).be.undefined();
      should(plan.model.runtimes.r).be.undefined();
      should(reviewCloneUpdate(analysis).items.find(item => item.ref === 'runtime/r')?.choice).equal('skip');
    });

    it('should leave out a nested profile chain whose end cannot be written', () => {
      // Arrange + Act: runtime r -> profile q -> profile p -> blocked hook c.
      const analysis = chain(owner, false);

      // Assert
      for (const ref of ['hooks/c', 'profile/p', 'profile/q', 'runtime/r']) {
        should(analysis.defaults.get(ref)).equal('skip');
      }
      should(planCloneUpdate(analysis, { decisions: {} }).files).eql([]);
    });

    it('should refuse writing any of the affected items, saying why', () => {
      // Arrange
      const analysis = chain(owner, false);

      // Act + Assert: the hook says who owns the tree; each dependent says what it needs.
      should(() => planCloneUpdate(analysis, { decisions: { 'hooks/c': 'add' } })).throw(CloneRefusal, {
        message: reason,
      });
      should(() => planCloneUpdate(analysis, { decisions: { 'profile/p': 'add' } })).throw(CloneRefusal, {
        message: /profile\/p needs hooks\/c/u,
      });
      should(() => planCloneUpdate(analysis, { decisions: { 'profile/q': 'add' } })).throw(CloneRefusal, {
        message: /profile\/q needs profile\/p/u,
      });
      should(() => planCloneUpdate(analysis, { decisions: { 'runtime/r': 'add' } })).throw(CloneRefusal, {
        message: /runtime\/r needs profile\/q/u,
      });
      should(() =>
        planCloneUpdate(analysis, {
          decisions: { 'hooks/c': 'add', 'profile/p': 'add', 'profile/q': 'add', 'runtime/r': 'add' },
        }),
      ).throw(CloneRefusal, { message: reason });
    });

    it('should still tick every item of the chain when nothing blocks it', () => {
      // Arrange + Act: the same chain onto a machine that owns nothing.
      const analysis = chain(parseAccountModel({ version: 2 }), false);
      const plan = planCloneUpdate(analysis, { decisions: {} });

      // Assert
      for (const ref of ['hooks/c', 'profile/p', 'profile/q', 'runtime/r']) {
        should(analysis.defaults.get(ref)).equal('add');
      }
      should(plan.files.map(file => file.path)).eql(['components/hooks/c/run.sh']);
      should(plan.model.runtimes.r?.profile).equal('q');
    });

    describe('a changed-on-both-sides item behind the blocked write', () => {
      const keyed = (layers: string[]) => ({ layers, clonedFromKey: KEY_P });
      const withP = (layers: string[]) =>
        parseAccountModel({
          version: 2,
          components: { hooks: { b: hooksAt('.', KEY_B) } },
          profiles: { p: keyed(layers) },
        });
      const sourceWith = (layers: string[]) =>
        sourceBundle({
          keys: { 'hooks/c': KEY_A, 'profile/p': KEY_P },
          components: hookC,
          files: fileC,
          profiles: { p: { layers } },
        });
      const lastCopied = (bundle: ReturnType<typeof sourceWith>, model: ReturnType<typeof withP>) =>
        applyCloneToBase(EMPTY_CLONE_BASE, {
          source: SOURCE,
          at: AT,
          replace: true,
          copied: cloneBaseEntries(bundle, bundle, new Map()),
          sourceKeys: new Set(cloneOriginKeys(bundle).values()),
          model,
        }).sources[SOURCE.id];

      it('should preset no choice for a both-changed profile that needs the blocked hook, and still refuse an undecided apply', () => {
        // Arrange: p is changed here (no last copy to compare) and now layers the blocked hook c.
        const analysis = analyseCloneUpdate(bareInput(sourceWith(['hooks/c']), withP([]), here));

        // Act
        const row = reviewCloneUpdate(analysis).items.find(item => item.ref === 'profile/p');

        // Assert: nothing is chosen for the owner; they must decide, and keep is the one that can be written.
        should(row?.outcome).equal('both');
        should(row?.needs).eql(['hooks/c']);
        should(row !== undefined && 'choice' in row).be.false();
        should(analysis.defaults.has('profile/p')).be.false();
        should(analysis.defaults.get('hooks/c')).equal('skip');
        should(() => planCloneUpdate(analysis, { decisions: {} })).throw(CloneRefusal);
        should(() => planCloneUpdate(analysis, { decisions: { 'profile/p': 'take' } })).throw(CloneRefusal, {
          message: /profile\/p needs hooks\/c/u,
        });
        const kept = planCloneUpdate(analysis, { decisions: { 'profile/p': 'keep' } });
        should(kept.files).eql([]);
        should(kept.model.profiles.p?.layers).eql([]);
      });

      it('should preset no choice for a both-changed profile whose dependency is blocked only through another profile', () => {
        // Arrange: p layers q, which layers the blocked hook c; q is new on the source side.
        const bundle = sourceBundle({
          keys: { 'hooks/c': KEY_A, 'profile/p': KEY_P, 'profile/q': KEY_Q },
          components: hookC,
          files: fileC,
          profiles: { p: { layers: ['profile/q'] }, q: { layers: ['hooks/c'] } },
        });
        const analysis = analyseCloneUpdate(bareInput(bundle, withP([]), here));

        // Act
        const review = reviewCloneUpdate(analysis);

        // Assert
        should(analysis.defaults.has('profile/p')).be.false();
        should(review.items.find(item => item.ref === 'profile/p')).not.have.property('choice');
        should(analysis.defaults.get('profile/q')).equal('skip');
        should(() => planCloneUpdate(analysis, { decisions: {} })).throw(CloneRefusal);
        should(planCloneUpdate(analysis, { decisions: { 'profile/p': 'keep' } }).files).eql([]);
      });

      it('should still default a source-only change behind the blocked hook to keep', () => {
        // Arrange: p was last copied with no layers and is unchanged here; only the source added hook c.
        const target = withP([]);
        const base = lastCopied(sourceWith([]), target);
        const analysis = analyseCloneUpdate({
          ...bareInput(sourceWith(['hooks/c']), target, here),
          ...(base === undefined ? {} : { base }),
        });

        // Act + Assert
        should(reviewCloneUpdate(analysis).items.find(item => item.ref === 'profile/p')?.outcome).equal('theirs');
        should(analysis.defaults.get('profile/p')).equal('keep');
        should(planCloneUpdate(analysis, { decisions: {} }).files).eql([]);
      });
    });
  });

  it('should refuse adding a new document while an item here owns the whole tree, and not tick it by default', () => {
    // Arrange: c is new; b here names the whole asset tree.
    const bundle = sourceBundle({
      keys: { 'hooks/c': KEY_A },
      components: { hooks: { c: { harness: 'claude', directory: 'components/hooks/c' } } },
      files: [{ path: 'components/hooks/c/run.sh', content: 'new' }],
    });
    const target = parseAccountModel({ version: 2, components: { hooks: { b: hooksAt('.', KEY_B) } } });
    const analysis = analyseCloneUpdate(bareInput(bundle, target, here));

    // Act
    const review = reviewCloneUpdate(analysis);
    const plan = planCloneUpdate(analysis, { decisions: {} });

    // Assert
    should(analysis.defaults.get('hooks/c')).equal('skip');
    should(review.items[0]?.note).containEql('hooks/b here uses the whole setup folder');
    should(plan.files).eql([]);
    should(() => planCloneUpdate(analysis, { decisions: { 'hooks/c': 'add' } })).throw(CloneRefusal, {
      message: /hooks\/b here uses the whole setup folder/u,
    });
  });

  it.each([
    ['an absolute alias', '/state/fleet/assets/components/hooks/shared', ROOTS],
    ['a ~/ alias', '~/fleet/assets/components/hooks/shared', home],
    ['a $HOME/ alias', '$HOME/fleet/assets/components/hooks/shared', home],
    ['a relative path that steps out and back', '../assets/components/hooks/shared', ROOTS],
  ])('should not write or remove in the folder a kept item here owns through %s', (_name, alias, roots) => {
    // Arrange: b changed on both sides, and the person keeps theirs here.
    const analysis = analyseCloneUpdate(bareInput(twoHooks(alias, 'codex'), withOwner(alias), here, { roots }));

    // Act
    const review = reviewCloneUpdate(analysis);
    const plan = planCloneUpdate(analysis, { decisions: { 'hooks/a': 'take', 'hooks/b': 'keep' } });

    // Assert: a lands in a folder of its own, and nothing in b's folder is written or removed.
    should(review.items.find(item => item.ref === 'hooks/a')?.note).containEql('is also used by hooks/b here');
    should(plan.files.map(file => file.path)).eql(['components/hooks/a/run.sh']);
    should(plan.removals).eql([]);
    should(plan.model.components.hooks.b?.directory).equal(alias);
    should(plan.model.components.hooks.a?.directory).equal('components/hooks/a');
  });
});

describe('a taken item lands exactly where its review listed it (#F575 finding 2)', () => {
  const home = { userHome: '/state', assetsDirectory: '/state/fleet/assets' };
  const spellings = [
    ['an absolute', '/state/fleet/assets/', ROOTS],
    ['a ~/', '~/fleet/assets/', home],
    ['a $HOME/', '$HOME/fleet/assets/', home],
  ] as const;

  it.each(spellings)(
    'should write and remove in the folder here named by %s alias, as reviewed',
    (_n, prefix, roots) => {
      // Arrange: this machine's a names components/hooks/old by an alias; the source's a lives elsewhere.
      const bundle = sourceBundle({
        keys: { 'hooks/a': KEY_A },
        components: { hooks: { a: { harness: 'claude', directory: 'components/hooks/source' } } },
        files: [{ path: 'components/hooks/source/run.sh', content: 'new' }],
      });
      const alias = `${prefix}components/hooks/old`;
      const target = parseAccountModel({ version: 2, components: { hooks: { a: hooksAt(alias, KEY_A) } } });
      const files = [
        { path: `${alias}/run.sh`, content: 'old' },
        { path: `${alias}/gone.sh`, content: 'dropped by the source' },
      ];
      const analysis = analyseCloneUpdate(bareInput(bundle, target, files, { roots }));

      // Act
      const review = reviewCloneUpdate(analysis);
      const plan = planCloneUpdate(analysis, { decisions: { 'hooks/a': 'take' } });

      // Assert: every write and removal is a path the review listed, in the folder it listed.
      const listed = review.items[0]?.files ?? [];
      should(listed.map(file => [file.path, file.change])).eql([
        ['components/hooks/old/gone.sh', 'removed'],
        ['components/hooks/old/run.sh', 'changed'],
      ]);
      should(plan.files).eql([{ path: 'components/hooks/old/run.sh', content: 'new' }]);
      should(plan.removals).eql(['components/hooks/old/gone.sh']);
      for (const path of [...plan.files.map(file => file.path), ...plan.removals]) {
        should(listed.map(file => file.path)).containEql(path);
      }
      should(plan.model.components.hooks.a?.directory).equal('components/hooks/old');
    },
  );

  it.each(spellings)('should write the document here named by %s alias, as reviewed', (_name, prefix, roots) => {
    // Arrange
    const bundle = sourceBundle({
      keys: { 'hooks/a': KEY_A },
      components: { hooks: { a: { harness: 'claude', file: 'components/hooks/source.json' } } },
      files: [{ path: 'components/hooks/source.json', content: '{"new":true}' }],
    });
    const alias = `${prefix}components/hooks/old.json`;
    const target = parseAccountModel({
      version: 2,
      components: { hooks: { a: { harness: 'claude', file: alias, ...FROM, clonedFromKey: KEY_A } } },
    });
    const analysis = analyseCloneUpdate(
      bareInput(bundle, target, [{ path: alias, content: '{"old":true}' }], { roots }),
    );

    // Act
    const review = reviewCloneUpdate(analysis);
    const plan = planCloneUpdate(analysis, { decisions: { 'hooks/a': 'take' } });

    // Assert
    should(review.items[0]?.files.map(file => file.path)).eql(['components/hooks/old.json']);
    should(plan.files).eql([{ path: 'components/hooks/old.json', content: '{"new":true}' }]);
    should(plan.removals).eql([]);
    should(plan.model.components.hooks.a?.file).equal('components/hooks/old.json');
  });
});

describe('an omitted subtree protects what is beneath it (#F544 finding 6, subtrees)', () => {
  const bundle = sourceBundle({
    keys: { 'hooks/a': KEY_A },
    components: { hooks: { a: { harness: 'claude', directory: 'components/hooks/a' } } },
    files: [{ path: 'components/hooks/a/keep.sh', content: 'keep' }],
    notCopied: [{ path: 'components/hooks/a/sub', reason: 'it is a link or a special file' }],
  });
  const target = parseAccountModel({
    version: 2,
    components: { hooks: { a: hooksAt('components/hooks/a', KEY_A) } },
  });
  const files = (...extra: { path: string; content: string }[]) => [
    { path: 'components/hooks/a/keep.sh', content: 'keep' },
    { path: 'components/hooks/a/sub/run.sh', content: 'local script must remain' },
    ...extra,
  ];

  it('should neither list nor remove a file beneath a folder the source left out', () => {
    // Arrange
    const analysis = analyseCloneUpdate(
      bareInput(bundle, target, files({ path: 'components/hooks/a/gone.sh', content: 'x' })),
    );

    // Act
    const review = reviewCloneUpdate(analysis);
    const plan = planCloneUpdate(analysis, { decisions: { 'hooks/a': 'take' } });

    // Assert: gone.sh is the source's to drop; sub/run.sh is not named anywhere.
    const named = review.items.flatMap(item => item.files.map(file => file.path));
    should(named).not.containEql('components/hooks/a/sub/run.sh');
    should(plan.removals).eql(['components/hooks/a/gone.sh']);
    should(plan.files.map(file => file.path)).not.containEql('components/hooks/a/sub/run.sh');
  });

  it('should leave the folder out of the comparison, so what is beneath it is never a change', () => {
    const analysis = analyseCloneUpdate(bareInput(bundle, target, files()));
    should(reviewCloneUpdate(analysis).items.flatMap(item => item.files)).eql([]);
    should(planCloneUpdate(analysis, { decisions: {} }).removals).eql([]);
  });
});

describe('a file both carried and marked not copied (#F544 finding 2)', () => {
  const masked = (content: string, notCopied = 'components/hooks/a/run.sh') =>
    sourceBundle({
      keys: { 'hooks/a': KEY_A },
      components: { hooks: { a: { harness: 'claude', directory: 'components/hooks/a' } } },
      files: [{ path: 'components/hooks/a/run.sh', content }],
      notCopied: [{ path: notCopied, reason: 'too large' }],
    });

  it('should refuse the bundle rather than compare the omission in place of the bytes', () => {
    for (const spelling of ['components/hooks/a/run.sh', './components/hooks/a//run.sh']) {
      should(() => analyseCloneUpdate(bareInput(masked('reviewed script', spelling)))).throw(CloneRefusal, {
        message: /carries .*run\.sh and also says it could not carry it/u,
      });
    }
  });
});

describe('a carried file beneath a folder marked not copied (#F575 finding 3)', () => {
  const contradictory = (content: string, marker = 'components/hooks/a/sub') =>
    sourceBundle({
      keys: { 'hooks/a': KEY_A },
      components: { hooks: { a: { harness: 'claude', directory: 'components/hooks/a' } } },
      files: [{ path: 'components/hooks/a/sub/run.sh', content }],
      notCopied: [{ path: marker, reason: 'it is a link or a special file' }],
    });
  const target = parseAccountModel({
    version: 2,
    components: { hooks: { a: hooksAt('components/hooks/a', KEY_A) } },
  });

  it('should refuse the bundle, never reading the carried change as the same', () => {
    for (const marker of ['components/hooks/a/sub', './components/hooks/a/sub/', 'components/hooks/a']) {
      should(() =>
        analyseCloneUpdate(
          bareInput(contradictory('new carried runnable', marker), target, [
            { path: 'components/hooks/a/sub/run.sh', content: 'old carried runnable' },
          ]),
        ),
      ).throw(CloneRefusal, {
        message: /carries components\/hooks\/a\/sub\/run\.sh and also says it could not carry/u,
      });
    }
  });

  it('should still protect what beneath the omitted folder the source did not carry', () => {
    // Arrange: the folder is omitted and nothing beneath it is carried.
    const bundle = sourceBundle({
      keys: { 'hooks/a': KEY_A },
      components: { hooks: { a: { harness: 'claude', directory: 'components/hooks/a' } } },
      files: [{ path: 'components/hooks/a/run.sh', content: 'new' }],
      notCopied: [{ path: 'components/hooks/a/sub', reason: 'it is a link or a special file' }],
    });
    const analysis = analyseCloneUpdate(
      bareInput(bundle, target, [
        { path: 'components/hooks/a/run.sh', content: 'old' },
        { path: 'components/hooks/a/sub/local.sh', content: 'only here' },
      ]),
    );

    // Act
    const plan = planCloneUpdate(analysis, { decisions: { 'hooks/a': 'take' } });

    // Assert: the carried change is listed and written; the uncarried one beneath the omission is untouched.
    should(reviewCloneUpdate(analysis).items[0]?.files.map(file => file.path)).eql(['components/hooks/a/run.sh']);
    should(plan.files).eql([{ path: 'components/hooks/a/run.sh', content: 'new' }]);
    should(plan.removals).eql([]);
  });
});

describe('profile and runtime settings an update writes (#F575 finding 4)', () => {
  const KEY_P = 'iiiiiiiiiiiiiiiiiiiiiiiiii';
  const KEY_R = 'jjjjjjjjjjjjjjjjjjjjjjjjjj';
  const KEY_L = 'kkkkkkkkkkkkkkkkkkkkkkkkkk';
  const theirs = (profile: Record<string, unknown>, runtime: Record<string, unknown>) =>
    sourceBundle({
      keys: { 'profile/default': KEY_P, 'runtime/agent': KEY_R, 'login/api': KEY_L },
      credentials: [{ id: 'api', harness: 'claude', label: 'api' }],
      profiles: { default: { layers: [], ...profile } },
      runtimes: { agent: { credential: 'api', profile: 'default', agent: true, ...runtime } },
    });
  const mine = (profile: Record<string, unknown>, runtime: Record<string, unknown>) =>
    parseAccountModel({
      version: 2,
      credentials: { api: { harness: 'claude', store: 'ferretry', label: 'api', ...FROM, clonedFromKey: KEY_L } },
      profiles: { default: { layers: [], clonedFromKey: KEY_P, ...profile } },
      runtimes: { agent: { credential: 'api', profile: 'default', agent: true, clonedFromKey: KEY_R, ...runtime } },
    });

  it('should add a profile and a runtime with the compactAt the source sets', () => {
    // Arrange
    const analysis = analyseCloneUpdate(bareInput(theirs({ compactAt: 200000 }, { compactAt: 250000 })));

    // Act
    const plan = planCloneUpdate(analysis, { decisions: {} });

    // Assert
    should(plan.done.added).containEql('profile/default');
    should(plan.done.added).containEql('runtime/agent');
    should(plan.model.profiles.default?.compactAt).equal(200000);
    should(plan.model.runtimes.agent?.compactAt).equal(250000);
  });

  it('should keep an explicit threshold here that the source shares when another field is taken', () => {
    // Arrange: only agent differs; both sides set the same thresholds.
    const analysis = analyseCloneUpdate(
      bareInput(
        theirs({ compactAt: 'auto' }, { compactAt: 250000, agent: false }),
        mine({ compactAt: 'auto' }, { compactAt: 250000 }),
      ),
    );

    // Act
    const plan = planCloneUpdate(analysis, { decisions: { 'runtime/agent': 'take' } });

    // Assert
    should(plan.done.taken).eql(['runtime/agent']);
    should(plan.model.runtimes.agent?.agent).be.false();
    should(plan.model.runtimes.agent?.compactAt).equal(250000);
    should(plan.model.profiles.default?.compactAt).equal('auto');
  });

  it('should update the threshold here to the one taken, and keep a runtime switched off here off', () => {
    // Arrange
    const disabled = { reason: 'spend limit reached' };
    const analysis = analyseCloneUpdate(
      bareInput(
        theirs({ compactAt: 200000 }, { compactAt: 250000 }),
        mine({ compactAt: 300000 }, { compactAt: 300000, disabled }),
      ),
    );

    // Act
    const plan = planCloneUpdate(analysis, { decisions: { 'profile/default': 'take', 'runtime/agent': 'take' } });

    // Assert
    should(plan.model.profiles.default?.compactAt).equal(200000);
    should(plan.model.runtimes.agent?.compactAt).equal(250000);
    should(plan.model.runtimes.agent?.disabled).eql(disabled);
  });

  it('should show a change to the runtime threshold alone as a change, naming the field', () => {
    // Arrange
    const analysis = analyseCloneUpdate(bareInput(theirs({}, { compactAt: 250000 }), mine({}, {})));

    // Act
    const review = reviewCloneUpdate(analysis);

    // Assert: the runtime is listed, not hidden as the same; the profile is the same.
    const runtime = review.items.find(item => item.ref === 'runtime/agent');
    should(runtime?.outcome).equal('both');
    should(runtime?.fields).eql(['compactAt']);
    should(review.items.map(item => item.ref)).eql(['runtime/agent']);
  });

  it('should name the profile threshold among the fields that differ', () => {
    const analysis = analyseCloneUpdate(bareInput(theirs({ compactAt: 200000 }, {}), mine({}, {})));
    should(reviewCloneUpdate(analysis).items.find(item => item.ref === 'profile/default')?.fields).eql(['compactAt']);
  });
});

describe('an environment login a copy adds (#F544 finding 3)', () => {
  const environment = (value: string) =>
    sourceBundle({
      keys: { 'login/api': KEY_API },
      credentials: [
        {
          id: 'api',
          harness: 'claude',
          store: 'environment',
          env: { NODE_OPTIONS: value, ANTHROPIC_API_KEY: '${secret:API_KEY}' },
        },
      ],
      profiles: { default: { layers: [] } },
      runtimes: { agent: { credential: 'api', profile: 'default', agent: false } },
    });

  it('should list everything it runs with, keeping a secret a reference', () => {
    const review = reviewCloneUpdate(analyseCloneUpdate(bareInput(environment('--trace-warnings'))));
    should(review.logins).eql([
      {
        sourceId: 'api',
        outcome: 'slot',
        runnable: {
          entries: [
            { label: 'Harness', text: 'claude', document: false },
            { label: 'Environment ANTHROPIC_API_KEY', text: '${secret:API_KEY}', document: false },
            { label: 'Environment NODE_OPTIONS', text: '--trace-warnings', document: false },
          ],
        },
      },
    ]);
  });

  it('should name a different review when the environment login changed after the review', () => {
    const before = analyseCloneUpdate(bareInput(environment('--trace-warnings')));
    const after = analyseCloneUpdate(bareInput(environment('--require /tmp/other-module.cjs')));
    should(after.fingerprint).not.equal(before.fingerprint);
  });

  it('should list the login as one the person is asked about too', () => {
    const bundle = environment('--trace-warnings');
    const review = reviewCloneUpdate(
      analyseCloneUpdate({
        ...bareInput(bundle),
        logins: { matched: new Map(), ask: new Map([['api', ['one', 'two']]]) },
      }),
    );
    should(review.logins[0]).match({ outcome: 'ask', candidates: ['one', 'two'], runnable: { entries: [{}, {}, {}] } });
  });

  it('should describe the new login as configured, not as one that needs sign-in', () => {
    const plan = planCloneUpdate(analyseCloneUpdate(bareInput(environment('--trace-warnings'))), { decisions: {} });
    should(plan.slots).eql([{ id: 'api', harness: 'claude', runtimes: ['agent'], environment: true }]);
    should(describeCloneUpdate(plan, 'work-linux', 'studio-mac').join('\n')).containEql(
      'Adds login api on work-linux with the environment configuration the review listed',
    );
  });
});

describe('the review binds what an apply acts on (#F544 finding 4)', () => {
  it('should name a different review when a gone item was edited here after the review', () => {
    const goneTarget = (command: string) =>
      parseAccountModel({ version: 2, components: { mcp: { old: { command, ...FROM, clonedFromKey: KEY_A } } } });
    const before = analyseCloneUpdate(bareInput(sourceBundle(), goneTarget('before-review')));
    const after = analyseCloneUpdate(bareInput(sourceBundle(), goneTarget('edited-here-after-review')));
    should(reviewCloneUpdate(before).items).match([{ ref: 'mcp/old', outcome: 'gone' }]);
    should(after.fingerprint).not.equal(before.fingerprint);
  });

  it('should name a different review when an item folder here moved after the review', () => {
    const bundle = sourceBundle({
      keys: { 'hooks/a': KEY_A },
      components: { hooks: { a: { harness: 'claude', directory: 'components/hooks/source' } } },
      files: [{ path: 'components/hooks/source/run.sh', content: 'take-source' }],
    });
    const at = (directory: string) =>
      analyseCloneUpdate(
        bareInput(bundle, parseAccountModel({ version: 2, components: { hooks: { a: hooksAt(directory, KEY_A) } } }), [
          { path: `${directory}/run.sh`, content: 'local' },
        ]),
      );
    const before = at('components/hooks/old');
    should(reviewCloneUpdate(before).items[0]?.files).match([{ path: 'components/hooks/old/run.sh' }]);
    should(at('components/hooks/moved').fingerprint).not.equal(before.fingerprint);
  });

  it('should refuse when a document an item owns here changed, or the record did', () => {
    const input = inputOf({ main: 'A' }, { main: 'A' }, { main: 'A' });
    const reviewedOnce = analyseCloneUpdate(input).fingerprint;
    should(analyseCloneUpdate(input).fingerprint).equal(reviewedOnce);
    const edited = analyseCloneUpdate({
      ...input,
      targetFiles: [
        { path: MAIN_PATH, content: 'A' },
        { path: 'x', content: 'y' },
      ],
    });
    should(edited.fingerprint).not.equal(reviewedOnce);
    const rebased = analyseCloneUpdate(inputOf({ main: 'A' }, { main: 'A' }, { main: 'B' }));
    should(rebased.fingerprint).not.equal(reviewedOnce);
  });
});

describe('items the person left out (#F544 finding 5)', () => {
  const withNew = (theirs: Side) =>
    FleetCloneBundleSchema.parse({
      ...bundleOf(theirs),
      keys: { ...keysOf(bundleOf(theirs)), 'mcp/skip-me': KEY_A },
      components: { ...bundleOf(theirs).components, mcp: { 'skip-me': { command: 'not-supposed-to-copy' } } },
    });

  it('should leave a skipped new item out, writing nothing for it', () => {
    const analysis = analyseCloneUpdate(
      inputOf({ main: 'A' }, { main: 'A' }, { main: 'A' }, { bundle: withNew({ main: 'A' }) }),
    );
    should(analysis.defaults.get('mcp/skip-me')).equal('add');
    const plan = planCloneUpdate(analysis, { decisions: {}, skip: ['mcp/skip-me'] });
    should(plan.model.components.mcp['skip-me']).be.undefined();
    should(plan.done.kept).containEql('mcp/skip-me');
  });

  it('should keep a skipped changed item, and settle a both item without asking', () => {
    const theirs = planCloneUpdate(analyseCloneUpdate(inputOf({ main: 'B' }, { main: 'A' }, { main: 'A' })), {
      decisions: {},
      skip: ['instructions/main'],
    });
    should(theirs.files).eql([]);
    const both = planCloneUpdate(analyseCloneUpdate(inputOf({ main: 'B' }, { main: 'C' }, { main: 'A' })), {
      decisions: { 'instructions/main': 'keep' },
      skip: ['instructions/main'],
    });
    should(both.files).eql([]);
    should(both.done.kept).containEql('instructions/main');
  });

  it('should accept leaving out an item that is already the same: nothing is written for it anyway', () => {
    const plan = planCloneUpdate(analyseCloneUpdate(inputOf({ main: 'A' }, { main: 'A' }, { main: 'A' })), {
      decisions: {},
      skip: ['instructions/main'],
    });
    should(plan.files).eql([]);
  });

  it('should refuse a skip that names nothing, or contradicts a decision, or strands what needs it', () => {
    const analysis = analyseCloneUpdate(inputOf({ main: 'B' }, { main: 'A' }, { main: 'A' }));
    should(() => planCloneUpdate(analysis, { decisions: {}, skip: ['mcp/nope'] })).throw(CloneRefusal, {
      message: 'The setup from studio-mac has no mcp/nope to leave out. Review it again.',
    });
    should(() =>
      planCloneUpdate(analysis, { decisions: { 'instructions/main': 'take' }, skip: ['instructions/main'] }),
    ).throw(CloneRefusal, { message: /instructions\/main is left out, but instructions\/main is also set to "take"/u });

    // A new profile needs a new component: leaving the component out leaves the profile without it.
    const bundle = FleetCloneBundleSchema.parse({
      ...withNew({ main: 'A' }),
      keys: { ...keysOf(withNew({ main: 'A' })), 'profile/extra': KEY_B },
      profiles: { ...withNew({ main: 'A' }).profiles, extra: { layers: ['mcp/skip-me'] } },
    });
    const needing = analyseCloneUpdate(inputOf({ main: 'A' }, { main: 'A' }, { main: 'A' }, { bundle }));
    should(() => planCloneUpdate(needing, { decisions: {}, skip: ['mcp/skip-me'] })).throw(CloneRefusal, {
      message: /profile\/extra needs mcp\/skip-me/u,
    });
  });
});

describe('files a take removes (#F544 finding 6)', () => {
  const folderBundle = sourceBundle({
    keys: { 'hooks/a': KEY_A },
    components: { hooks: { a: { harness: 'claude', directory: 'components/hooks/a' } } },
    files: [{ path: 'components/hooks/a/keep.sh', content: 'keep, changed' }],
    notCopied: [{ path: 'components/hooks/a/huge.bin', reason: 'too large' }],
  });
  const folderTarget = parseAccountModel({
    version: 2,
    components: { hooks: { a: hooksAt('components/hooks/a', KEY_A) } },
  });
  const folderFiles = [
    { path: 'components/hooks/a/keep.sh', content: 'keep' },
    { path: 'components/hooks/a/gone.sh', content: 'still runs' },
    { path: 'components/hooks/a/huge.bin', content: 'not carried' },
  ];

  it('should remove what the review listed as removed, and never a file the source could not carry', () => {
    // Arrange
    const analysis = analyseCloneUpdate(bareInput(folderBundle, folderTarget, folderFiles));

    // Act
    const files = reviewCloneUpdate(analysis).items[0]?.files.map(file => `${file.path}:${file.change}`);
    const taken = planCloneUpdate(analysis, { decisions: { 'hooks/a': 'take' } });
    const kept = planCloneUpdate(analysis, { decisions: { 'hooks/a': 'keep' } });

    // Assert
    should(files).eql(['components/hooks/a/gone.sh:removed', 'components/hooks/a/keep.sh:changed']);
    should(taken.removals).eql(['components/hooks/a/gone.sh']);
    should(taken.files).eql([{ path: 'components/hooks/a/keep.sh', content: 'keep, changed' }]);
    should(kept.removals).eql([]);
  });

  it('should never remove a lone document the source stopped naming', () => {
    const bundle = sourceBundle({
      keys: { 'settings/s': KEY_A },
      components: { settings: { s: { harness: 'claude', flags: ['--verbose'] } } },
    });
    const target = parseAccountModel({
      version: 2,
      components: {
        settings: { s: { harness: 'claude', file: 'components/settings/s.json', ...FROM, clonedFromKey: KEY_A } },
      },
    });
    const analysis = analyseCloneUpdate(
      bareInput(bundle, target, [{ path: 'components/settings/s.json', content: '{}' }]),
    );
    should(planCloneUpdate(analysis, { decisions: { 'settings/s': 'take' } }).removals).eql([]);
  });
});

describe('matching a login by email or label after the record and the key (#F544 finding 7)', () => {
  const sourceLogin = (patch: Record<string, unknown> = {}) =>
    sourceBundle({ credentials: [{ id: 'you', harness: 'claude', label: 'work', ...patch }] });
  const heldBy = (credentials: Record<string, Record<string, unknown>>) =>
    parseAccountModel({
      version: 2,
      credentials: Object.fromEntries(
        Object.entries(credentials).map(([id, held]) => [id, { harness: 'claude', store: 'ferretry', ...held }]),
      ),
    });
  const resolved = (
    bundle: FleetCloneBundle,
    target: ReturnType<typeof parseAccountModel>,
    emails: Record<string, string | undefined> = {},
  ) => resolveCloneLogins(bundle, target, undefined, emails);

  it('should reuse the same-harness login with the same label when neither side has an email', () => {
    const found = resolved(sourceLogin(), heldBy({ existing: { label: 'work' }, other: { label: 'play' } }));
    should([...found.matched]).eql([['you', 'existing']]);
    should(found.ask.size).equal(0);
  });

  it('should reuse a login by email, ignoring case and spaces', () => {
    const found = resolved(
      sourceLogin({ email: 'Person@Example.test' }),
      heldBy({ existing: { label: 'unrelated' } }),
      { existing: ' person@example.TEST ' },
    );
    should([...found.matched]).eql([['you', 'existing']]);
  });

  it('should not fall back to the label when either side has an email', () => {
    should(
      resolved(sourceLogin({ email: 'a@example.test' }), heldBy({ existing: { label: 'work' } })).matched.size,
    ).equal(0);
    should(
      resolved(sourceLogin(), heldBy({ existing: { label: 'work' } }), { existing: 'a@example.test' }).matched.size,
    ).equal(0);
  });

  it('should never match a login of another harness, or an API-key login', () => {
    const target = heldBy({
      codex: { harness: 'codex', label: 'work' },
      api: { store: 'environment', label: 'work', env: { ANTHROPIC_API_KEY: '${secret:API_TOKEN}' } },
    });
    const found = resolved(sourceLogin(), target);
    should(found.matched.size).equal(0);
    should(found.ask.size).equal(0);
    const api = sourceBundle({
      credentials: [
        {
          id: 'you',
          harness: 'claude',
          label: 'work',
          store: 'environment',
          env: { ANTHROPIC_API_KEY: '${secret:API_TOKEN}' },
        },
      ],
    });
    should(resolved(api, heldBy({ existing: { label: 'work' } })).matched.size).equal(0);
  });

  it('should ask when two logins fit, listing both', () => {
    const found = resolved(sourceLogin(), heldBy({ zed: { label: 'work' }, abe: { label: 'work' } }));
    should(found.matched.size).equal(0);
    should([...found.ask]).eql([['you', ['abe', 'zed']]]);
  });

  it('should ask the matcher only when the record and the key said nothing', () => {
    const keyed = sourceBundle({
      keys: { 'login/you': KEY_API },
      credentials: [{ id: 'you', harness: 'claude', label: 'work' }],
    });
    const linked = heldBy({ linked: { label: 'other', ...FROM, clonedFromKey: KEY_API }, same: { label: 'work' } });
    should([...resolved(keyed, linked).matched]).eql([['you', 'linked']]);
  });

  describe('through an update', () => {
    const runtimeOn = (login: Record<string, unknown>) =>
      sourceBundle({
        credentials: [{ id: 'you', harness: 'claude', ...login }],
        runtimes: { agent: { credential: 'you', profile: 'default', agent: false } },
        profiles: { default: { layers: [] } },
      });
    const update = (
      bundle: FleetCloneBundle,
      target: ReturnType<typeof parseAccountModel>,
      emails: Record<string, string | undefined> = {},
    ): CloneUpdateInput => bareInput(bundle, target, [], { logins: resolved(bundle, target, emails) });
    const TAKE = { decisions: { 'runtime/agent': 'add' } } as const;

    it('should point a new runtime at the existing login, with no slot and no new login', () => {
      const target = heldBy({ existing: { label: 'work' } });
      const before = JSON.stringify(target.credentials);
      const input = update(runtimeOn({ label: 'work' }), target);
      should(reviewed(input).logins).eql([{ sourceId: 'you', outcome: 'matched', target: 'existing' }]);
      const plan = planCloneUpdate(analyseCloneUpdate(input), TAKE);
      should(plan.slots).eql([]);
      should(Object.keys(plan.model.credentials)).eql(['existing']);
      should(plan.model.runtimes.agent?.credential).equal('existing');
      should(JSON.stringify(plan.model.credentials)).equal(before);
    });

    it('should put the matched login in the review fingerprint', () => {
      const bundle = runtimeOn({ label: 'work' });
      const one = analyseCloneUpdate(update(bundle, heldBy({ a: { label: 'work' } }))).fingerprint;
      const other = analyseCloneUpdate(update(bundle, heldBy({ b: { label: 'work' } }))).fingerprint;
      should(one).not.equal(other);
    });

    it('should list two candidates for the person and refuse to apply without a decision', () => {
      const input = update(runtimeOn({ label: 'work' }), heldBy({ abe: { label: 'work' }, zed: { label: 'work' } }));
      should(reviewed(input).logins).eql([{ sourceId: 'you', outcome: 'ask', candidates: ['abe', 'zed'] }]);
      should(() => planCloneUpdate(analyseCloneUpdate(input), TAKE)).throw(CloneRefusal);
      const plan = planCloneUpdate(analyseCloneUpdate(input), { ...TAKE, logins: { you: 'zed' } });
      should(plan.model.runtimes.agent?.credential).equal('zed');
      should(plan.slots).eql([]);
    });
  });
});

// ── The §3 table, every row, for every kind (#F544 finding 8) ───────────────────────────────────

type Kind = (typeof COMPONENT_KINDS)[number] | 'profile' | 'runtime';
const KEY_X = 'iiiiiiiiiiiiiiiiiiiiiiiiii';
const SCAFFOLD_KEYS: Record<string, string> = {
  'instructions/l-A': 'jjjjjjjjjjjjjjjjjjjjjjjjjj',
  'instructions/l-B': 'kkkkkkkkkkkkkkkkkkkkkkkkkk',
  'instructions/l-C': 'llllllllllllllllllllllllll',
  'profile/p-A': 'mmmmmmmmmmmmmmmmmmmmmmmmmm',
  'profile/p-B': 'nnnnnnnnnnnnnnnnnnnnnnnnnn',
  'profile/p-C': 'oooooooooooooooooooooooooo',
  'login/claude-you': KEY_LOGIN,
};

/** Item `x` of a kind at version `v`: its declaration and the documents it owns. */
const versionOf = (
  kind: Kind,
  v: string,
): { value: Record<string, unknown>; files: { path: string; content: string }[] } => {
  switch (kind) {
    case 'instructions':
      return {
        value: { file: 'components/instructions/x.md' },
        files: [{ path: 'components/instructions/x.md', content: v }],
      };
    case 'mcp':
      return { value: { command: `run-${v}` }, files: [] };
    case 'skills':
      return { value: { items: ['x'] }, files: [{ path: 'skills/x/SKILL.md', content: v }] };
    case 'settings':
      return {
        value: { harness: 'claude', file: 'components/settings/x.json' },
        files: [{ path: 'components/settings/x.json', content: JSON.stringify({ v }) }],
      };
    case 'hooks':
      return {
        value: { harness: 'claude', directory: 'components/hooks/x' },
        files: [{ path: 'components/hooks/x/run.sh', content: v }],
      };
    case 'modelSets':
      return { value: { models: [`m-${v}`], default: `m-${v}` }, files: [] };
    case 'profile':
      return { value: { layers: [`instructions/l-${v}`] }, files: [] };
    case 'runtime':
      return { value: { credential: 'claude-you', profile: `p-${v}`, agent: false }, files: [] };
  }
};

const refOf = (kind: Kind): string => `${kind}/x`;

/** What both sides share, unchanged: three instructions, three profiles and the login. */
const scaffold = () => ({
  instructions: Object.fromEntries(['A', 'B', 'C'].map(v => [`l-${v}`, { file: `components/instructions/l-${v}.md` }])),
  files: ['A', 'B', 'C'].map(v => ({ path: `components/instructions/l-${v}.md`, content: v })),
  profiles: Object.fromEntries(['A', 'B', 'C'].map(v => [`p-${v}`, { layers: [] }])),
});

/** The source holding `x` at `v`, or not at all. */
const matrixBundle = (kind: Kind, v: string | undefined): FleetCloneBundle => {
  const shared = scaffold();
  const x = v === undefined ? undefined : versionOf(kind, v);
  const components: Record<string, Record<string, unknown>> = { instructions: { ...shared.instructions } };
  const profiles: Record<string, unknown> = { ...shared.profiles };
  const runtimes: Record<string, unknown> = {};
  if (x !== undefined) {
    if (kind === 'profile') profiles.x = x.value;
    else if (kind === 'runtime') runtimes.x = x.value;
    else components[kind] = { ...components[kind], x: x.value };
  }
  return sourceBundle({
    keys: { ...SCAFFOLD_KEYS, ...(x === undefined ? {} : { [refOf(kind)]: KEY_X }) },
    credentials: [{ id: 'claude-you', harness: 'claude', label: 'you' }],
    components,
    profiles,
    runtimes,
    files: [...shared.files, ...(x?.files ?? [])],
  });
};

/** This machine holding `x` at `v` (linked to the source), or not at all. */
const matrixTarget = (kind: Kind, v: string | undefined) => {
  const shared = scaffold();
  const link = (reference: string) => ({ clonedFromKey: SCAFFOLD_KEYS[reference] as string });
  const x = v === undefined ? undefined : versionOf(kind, v);
  const instructions: Record<string, unknown> = Object.fromEntries(
    Object.entries(shared.instructions).map(([name, value]) => [
      name,
      { ...value, ...FROM, ...link(`instructions/${name}`) },
    ]),
  );
  const components: Record<string, Record<string, unknown>> = { instructions };
  const profiles: Record<string, unknown> = Object.fromEntries(
    Object.entries(shared.profiles).map(([name, value]) => [name, { ...value, ...link(`profile/${name}`) }]),
  );
  const runtimes: Record<string, unknown> = {};
  if (x !== undefined) {
    if (kind === 'profile') profiles.x = { ...x.value, clonedFromKey: KEY_X };
    else if (kind === 'runtime') runtimes.x = { ...x.value, clonedFromKey: KEY_X };
    else components[kind] = { ...components[kind], x: { ...x.value, ...FROM, clonedFromKey: KEY_X } };
  }
  return {
    model: parseAccountModel({
      version: 2,
      credentials: {
        'claude-you': { harness: 'claude', store: 'ferretry', label: 'you', ...FROM, clonedFromKey: KEY_LOGIN },
      },
      components,
      profiles,
      runtimes,
    }),
    files: [...shared.files, ...(x?.files ?? [])],
  };
};

const matrixInput = (kind: Kind, theirs?: string, mine?: string, base?: string): CloneUpdateInput => {
  const here = matrixTarget(kind, mine);
  const bundle = matrixBundle(kind, theirs);
  const record =
    base === undefined
      ? undefined
      : applyCloneToBase(EMPTY_CLONE_BASE, {
          source: SOURCE,
          at: AT,
          replace: true,
          copied: cloneBaseEntries(
            matrixBundle(kind, base),
            matrixBundle(kind, base),
            new Map([['claude-you', 'claude-you']]),
          ),
          sourceKeys: new Set(cloneOriginKeys(matrixBundle(kind, base)).values()),
          model: matrixTarget(kind, base).model,
        }).sources[SOURCE.id];
  return {
    ...bareInput(bundle, here.model, here.files),
    ...(record === undefined ? {} : { base: record }),
    logins: { matched: new Map([['claude-you', 'claude-you']]), ask: new Map() },
  };
};

describe('the three-way table for every kind (design §3)', () => {
  const rows: readonly {
    readonly name: string;
    readonly theirs?: string;
    readonly mine?: string;
    readonly base?: string;
    readonly outcome: string | undefined;
    readonly choice: string | undefined;
  }[] = [
    {
      name: 'mine = theirs is the same, whatever the base',
      theirs: 'B',
      mine: 'B',
      base: 'A',
      outcome: undefined,
      choice: undefined,
    },
    {
      name: 'changed on the source is theirs, taken',
      theirs: 'B',
      mine: 'A',
      base: 'A',
      outcome: 'theirs',
      choice: 'take',
    },
    { name: 'changed here is mine, kept', theirs: 'A', mine: 'B', base: 'A', outcome: 'mine', choice: 'keep' },
    {
      name: 'changed on both is both, unchosen',
      theirs: 'C',
      mine: 'B',
      base: 'A',
      outcome: 'both',
      choice: undefined,
    },
    { name: 'neither here nor in the record is new, added', theirs: 'A', outcome: 'new', choice: 'add' },
    { name: 'dropped by the source is gone, kept', mine: 'A', base: 'A', outcome: 'gone', choice: 'keep' },
    { name: 'removed here stays removed', theirs: 'A', base: 'A', outcome: 'removed-here', choice: 'keep' },
  ];
  for (const kind of [...COMPONENT_KINDS, 'profile', 'runtime'] as const) {
    for (const row of rows) {
      it(`should read ${kind}: ${row.name}`, () => {
        // Arrange
        const analysis = analyseCloneUpdate(matrixInput(kind, row.theirs, row.mine, row.base));

        // Act
        const review = reviewCloneUpdate(analysis);
        const item = review.items.find(entry => entry.ref === refOf(kind));

        // Assert: only x can differ; the scaffold is the same on both sides.
        should(review.items.filter(entry => entry.ref !== refOf(kind))).eql([]);
        should(item?.outcome).equal(row.outcome);
        should(item?.choice).equal(row.choice);
        if (row.outcome === undefined) should(review.same.count).be.above(0);
        if (row.outcome === 'theirs') {
          // Taking it leaves this machine with what the source has.
          const plan = planCloneUpdate(analysis, { decisions: {} });
          should(plan.done.taken).eql([refOf(kind)]);
        }
      });
    }
  }
});
