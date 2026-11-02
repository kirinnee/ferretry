import { describe, it } from 'bun:test';
import { type FleetCloneBundle, FleetCloneBundleSchema } from '@ferretry/protocol';
import should from 'should';
import {
  analyseCloneUpdate,
  cloneBaseFor,
  type CloneUpdateInput,
  planCloneUpdate,
  reviewCloneUpdate,
} from '../../src/lib/account/clone-update.ts';
import {
  applyCloneToBase,
  type CloneBase,
  cloneBaseEntries,
  cloneOriginKeys,
  EMPTY_CLONE_BASE,
} from '../../src/lib/account/clone-base.ts';
import { CloneRefusal } from '../../src/lib/account/clone-parts.ts';
import { parseAccountModel } from '../../src/lib/account/schema.ts';

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
    const { planClone } = await import('../../src/lib/account/clone.ts');
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
    const { resolveCloneLogins } = await import('../../src/lib/account/clone-update.ts');
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
    const { describeCloneUpdate } = await import('../../src/lib/account/clone-update.ts');
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
    const { describeCloneUpdate } = await import('../../src/lib/account/clone-update.ts');
    const plan = {
      done: { taken: ['a'], added: [], removed: [], kept: [], linked: ['instructions/main'] },
      same: { count: 2, probable: 1 },
      runnables: [],
      slots: [{ id: 'claude-you', harness: 'claude', runtimes: ['claude-default'] }],
      checkPaths: [{ reference: 'hooks/guard', path: '/home/x/guard.sh' }],
      missingHarnesses: ['claude'],
      missingSecrets: ['API_TOKEN'],
      keptSkillItems: ['review'],
    };
    const text = describeCloneUpdate(plan as never, 'work-linux', 'studio-mac').join('\n');
    for (const part of [
      'Links 1 item to studio-mac by name',
      'empty login claude-you',
      'Check after copying: hooks/guard names /home/x/guard.sh',
      "claude isn't installed on work-linux",
      'no API_TOKEN',
      'Skill review is already on work-linux',
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
  it('should refuse an apply that names no review or another one, and accept the same one', async () => {
    const { checkCloneReviewed } = await import('../../src/lib/account/clone-update.ts');
    const analysis = analyseCloneUpdate(inputOf({ main: 'B' }, { main: 'A' }, { main: 'A' }));
    should(() => checkCloneReviewed(analysis, undefined)).throw(CloneRefusal);
    should(() => checkCloneReviewed(analysis, 'other')).throw(CloneRefusal);
    checkCloneReviewed(analysis, analysis.fingerprint);
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
