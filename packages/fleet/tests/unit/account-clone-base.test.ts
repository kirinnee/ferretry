import { describe, it } from 'bun:test';
import { type FleetCloneBundle, FleetCloneBundleSchema, sha256Hex } from '@ferretry/protocol';
import should from 'should';
import {
  applyCloneToBase,
  CLONE_BASE_ITEMS_LIMIT,
  CLONE_BASE_SOURCES_LIMIT,
  type CloneBase,
  type CloneBaseEntry,
  type CloneBaseItem,
  cloneOriginKeys,
  cloneSourceIdentity,
  CloneSourceMismatch,
  EMPTY_CLONE_BASE,
  forgetCloneSource,
  linkedKeys,
  parseCloneBase,
  serializeCloneBase,
} from '../../src/lib/account/clone-base.ts';
import { type CloneOptions, planClone } from '../../src/lib/account/clone.ts';
import { type AccountModel, parseAccountModel } from '../../src/lib/account/schema.ts';

const KEY_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const KEY_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
const KEY_C = 'cccccccccccccccccccccccccc';
const KEY_D = 'dddddddddddddddddddddddddd';
const KEY_E = 'eeeeeeeeeeeeeeeeeeeeeeeeee';
const DIGEST = 'f'.repeat(64);
const AT = '2026-10-13T08:00:00.000Z';

const options = (patch: Partial<CloneOptions> = {}): CloneOptions => ({
  mode: 'alongside',
  machine: 'work-linux',
  installed: ['claude', 'codex'],
  existingSkillItems: [],
  existingSecrets: [],
  ...patch,
});

const bundleShape = {
  format: 'ferretry-clone',
  machine: 'studio-mac',
  exportedAt: '2026-10-13T07:00:00.000Z',
  credentials: [{ id: 'claude-you', harness: 'claude', label: 'you', email: 'person@example.test' }],
  components: { instructions: { main: { file: 'components/instructions/main.md' } } },
  profiles: { default: { layers: ['instructions/main'] } },
  runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: false } },
  files: [{ path: 'components/instructions/main.md', content: '# Main' }],
  notCopied: [],
};

const V1 = (): FleetCloneBundle => FleetCloneBundleSchema.parse({ ...bundleShape, version: 1 });

const KEYS = {
  'instructions/main': KEY_A,
  'profile/default': KEY_B,
  'runtime/claude-default': KEY_C,
  'login/claude-you': KEY_D,
};
const V2 = (patch: Record<string, unknown> = {}): FleetCloneBundle =>
  FleetCloneBundleSchema.parse({ ...bundleShape, version: 2, daemon: 'daemon-source', keys: KEYS, ...patch });

const emptyTarget = (patch: Record<string, unknown> = {}): AccountModel => parseAccountModel({ version: 2, ...patch });

const item = (patch: Partial<CloneBaseItem> = {}): CloneBaseItem => ({
  kind: 'instructions',
  sourceName: 'main',
  digest: DIGEST,
  bytes: 10,
  ...patch,
});

const entry = (key: string, patch: Partial<CloneBaseItem> = {}): CloneBaseEntry => ({ key, ...item(patch) });

/** A model whose instructions carry these origin keys, so they count as linked to a source. */
const linkedModel = (...keys: string[]): AccountModel =>
  parseAccountModel({
    version: 2,
    components: {
      instructions: Object.fromEntries(
        keys.map((key, index) => [
          `item${String(index)}`,
          { file: `components/instructions/${String(index)}.md`, clonedFromKey: key },
        ]),
      ),
    },
  });

const source = (items: Record<string, CloneBaseItem>, lastCopiedAt = AT) => ({
  name: 'work-mac',
  verified: 'self' as const,
  lastCopiedAt,
  items,
});

const update = (
  patch: Partial<Parameters<typeof applyCloneToBase>[1]> = {},
): Parameters<typeof applyCloneToBase>[1] => ({
  source: { id: 'daemon-source', name: 'work-mac', verified: 'self' },
  at: AT,
  replace: false,
  copied: [],
  sourceKeys: new Set(),
  model: emptyTarget(),
  ...patch,
});

describe('parseCloneBase', () => {
  it('should read what serializeCloneBase wrote, byte for byte', () => {
    const base: CloneBase = { version: 1, sources: { z: source({ [KEY_B]: item(), [KEY_A]: item() }), a: source({}) } };
    const text = serializeCloneBase(base);
    should(parseCloneBase(text)).deepEqual(base);
    should(serializeCloneBase(parseCloneBase(text))).equal(text);
    should(Object.keys(JSON.parse(text).sources)).deepEqual(['a', 'z']);
  });

  it.each([
    ['absent', undefined],
    ['not JSON', '{nope'],
    ['an array', '[]'],
    ['another version', JSON.stringify({ version: 2, sources: {} })],
    ['an unknown field', JSON.stringify({ version: 1, sources: {}, extra: true })],
    ['a bad origin key', JSON.stringify({ version: 1, sources: { s: source({ short: item() }) } })],
    [
      'a digest that is not sha256',
      JSON.stringify({ version: 1, sources: { s: source({ [KEY_A]: item({ digest: 'x' }) }) } }),
    ],
    [
      'an unknown item field',
      JSON.stringify({ version: 1, sources: { s: source({ [KEY_A]: { ...item(), content: 'secret' } as never }) } }),
    ],
  ])('should treat %s as no record at all', (_label, text) => {
    should(parseCloneBase(text)).equal(EMPTY_CLONE_BASE);
  });

  it('should refuse more than 32 sources, or 4096 items for one source, as no record', () => {
    const many = Object.fromEntries(
      Array.from({ length: CLONE_BASE_SOURCES_LIMIT + 1 }, (_, index) => [`s${String(index)}`, source({})]),
    );
    should(parseCloneBase(JSON.stringify({ version: 1, sources: many }))).equal(EMPTY_CLONE_BASE);
    const atLimit = Object.fromEntries(
      Array.from({ length: CLONE_BASE_SOURCES_LIMIT }, (_, index) => [`s${String(index)}`, source({})]),
    );
    should(Object.keys(parseCloneBase(JSON.stringify({ version: 1, sources: atLimit })).sources)).have.length(32);

    const keyOf = (index: number): string =>
      [...index.toString(6).padStart(26, '0')].map(digit => '234567'[Number(digit)]).join('');
    const items = (count: number): Record<string, CloneBaseItem> =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [keyOf(index), item()]));
    const tooMany = JSON.stringify({ version: 1, sources: { s: source(items(CLONE_BASE_ITEMS_LIMIT + 1)) } });
    should(parseCloneBase(tooMany)).equal(EMPTY_CLONE_BASE);
  });

  it('should hold only digests, sizes, paths and instants: a key entry has no value field', () => {
    const withKeys = {
      version: 1,
      sources: {
        s: {
          ...source({}),
          keys: { OPENAI_API_KEY: { sourceUpdatedAt: AT, targetUpdatedAt: AT } },
        },
      },
    };
    should(Object.values(parseCloneBase(JSON.stringify(withKeys)).sources.s?.keys ?? {})[0]).deepEqual({
      sourceUpdatedAt: AT,
      targetUpdatedAt: AT,
    });
    const leaking = {
      ...withKeys,
      sources: {
        s: {
          ...withKeys.sources.s,
          keys: { OPENAI_API_KEY: { sourceUpdatedAt: AT, targetUpdatedAt: AT, value: 'sk' } },
        },
      },
    };
    should(parseCloneBase(JSON.stringify(leaking))).equal(EMPTY_CLONE_BASE);
  });
});

describe('cloneSourceIdentity', () => {
  it('should give a version 1 bundle no identity unless the browser verified one', () => {
    should(cloneSourceIdentity(V1(), undefined, undefined)).be.undefined();
    should(cloneSourceIdentity(V1(), 'sha256:work', 'Work Mac')).deepEqual({
      id: 'sha256:work',
      name: 'Work Mac',
      verified: 'browser',
    });
  });

  it('should file a version 2 bundle under what it said of itself, as unverified', () => {
    should(cloneSourceIdentity(V2(), undefined, undefined)).deepEqual({
      id: 'daemon-source',
      name: 'studio-mac',
      verified: 'self',
    });
  });

  it('should prefer the id the browser verified when it agrees with the bundle', () => {
    should(cloneSourceIdentity(V2(), 'daemon-source', undefined)?.verified).equal('browser');
  });

  it('should refuse a bundle that names another machine than the one picked', () => {
    const attempt = (): unknown => cloneSourceIdentity(V2(), 'daemon-other', undefined);
    should(attempt).throw(CloneSourceMismatch);
    should(attempt).throw('That export says it is from another machine than the one you picked.');
  });

  it('should read an oversized self-reported id as no identity, and refuse it beside a verified id', () => {
    const huge = { ...V2(), daemon: 'd'.repeat(201) } as ReturnType<typeof V2>;
    should(cloneSourceIdentity(huge, undefined, undefined)).be.undefined();
    should(() => cloneSourceIdentity(huge, 'daemon-source', undefined)).throw(CloneSourceMismatch);
  });

  it('should cut a display name to 120 characters', () => {
    should(cloneSourceIdentity(V2(), undefined, 'x'.repeat(300))?.name).have.length(120);
  });
});

describe('cloneOriginKeys', () => {
  it('should take the keys of items the bundle has, and none from a version 1 bundle', () => {
    should([...cloneOriginKeys(V2())]).deepEqual(Object.entries(KEYS));
    should(cloneOriginKeys(V1()).size).equal(0);
  });

  it('should drop a key two items claim, and a key for an item the bundle does not have', () => {
    const keys = cloneOriginKeys(V2({ keys: { ...KEYS, 'profile/default': KEY_A, 'mcp/ghost': KEY_E } }));
    should(keys.has('instructions/main')).be.false();
    should(keys.has('profile/default')).be.false();
    should(keys.has('mcp/ghost')).be.false();
    should(keys.get('runtime/claude-default')).equal(KEY_C);
  });
});

describe('planClone stamping and base', () => {
  const stamps = (model: AccountModel): (string | undefined)[] => [
    ...Object.values(model.components.instructions).map(component => component.clonedFromKey),
    ...Object.values(model.profiles).map(profile => profile.clonedFromKey),
    ...Object.values(model.runtimes).map(runtime => runtime.clonedFromKey),
    ...Object.values(model.credentials).map(credential => credential.clonedFromKey),
  ];

  it('should stamp every item a version 2 copy writes with the key the source gave it', () => {
    const plan = planClone(emptyTarget(), V2(), options());
    should(stamps(plan.model).toSorted()).deepEqual([KEY_A, KEY_B, KEY_C, KEY_D]);
  });

  it('should stamp nothing for a version 1 copy, and record nothing', () => {
    const plan = planClone(emptyTarget(), V1(), options());
    should(stamps(plan.model).filter(stamp => stamp !== undefined)).deepEqual([]);
    should(plan.base).deepEqual([]);
    should(plan.sourceKeys.size).equal(0);
  });

  it('should replace a key the source claimed on its own items with the one the bundle carries', () => {
    const claimed = V2({
      components: { instructions: { main: { file: 'components/instructions/main.md', clonedFromKey: KEY_E } } },
    });
    const model = planClone(emptyTarget(), claimed, options()).model;
    should(Object.values(model.components.instructions)[0]?.clonedFromKey).equal(KEY_A);
  });

  it('should record the source side of every copied item, computed here, with its documents', () => {
    const plan = planClone(emptyTarget(), V2(), options());
    const main = plan.base.find(each => each.key === KEY_A);
    should(main?.kind).equal('instructions');
    should(main?.sourceName).equal('main');
    should(main?.files).deepEqual({
      'components/instructions/main.md': { digest: sha256Hex('# Main'), bytes: 6 },
    });
    should(main?.digest).match(/^[0-9a-f]{64}$/u);
    should(plan.base.map(each => each.kind).toSorted()).deepEqual(['instructions', 'login', 'profile', 'runtime']);
    should(plan.sourceKeys).deepEqual(new Set([KEY_A, KEY_B, KEY_C, KEY_D]));
  });

  it('should record a digest that changes when the source item changes, and not when only its name does', () => {
    const digestOf = (bundle: FleetCloneBundle): string | undefined =>
      planClone(emptyTarget(), bundle, options()).base.find(each => each.key === KEY_A)?.digest;
    const changed = V2({ files: [{ path: 'components/instructions/main.md', content: '# Main, edited' }] });
    should(digestOf(changed)).not.equal(digestOf(V2()));
    const sameButOtherMachine = V2({ machine: 'another-name' });
    should(digestOf(sameButOtherMachine)).equal(digestOf(V2()));
  });

  it('should name the login here a source login was matched to', () => {
    const plan = planClone(emptyTarget(), V2(), options());
    const login = plan.base.find(each => each.key === KEY_D);
    should(Object.keys(plan.model.credentials)).containEql(login?.login);
  });

  it('should leave a skipped component out of what it records, yet keep its key as one the source holds', () => {
    const plan = planClone(emptyTarget(), V2(), options({ skip: ['instructions/main'] }));
    should(plan.base.some(each => each.key === KEY_A)).be.false();
    should(plan.sourceKeys.has(KEY_A)).be.true();
  });
});

describe('applyCloneToBase', () => {
  it('should record what the copy wrote under the source, with the instant of the copy', () => {
    const copied = [entry(KEY_A), entry(KEY_B, { kind: 'profile', sourceName: 'default' })];
    const next = applyCloneToBase(
      EMPTY_CLONE_BASE,
      update({ copied, sourceKeys: new Set([KEY_A, KEY_B]), model: linkedModel(KEY_A, KEY_B) }),
    );
    should(Object.keys(next.sources)).deepEqual(['daemon-source']);
    should(next.sources['daemon-source']?.lastCopiedAt).equal(AT);
    should(next.sources['daemon-source']?.verified).equal('self');
    should(Object.keys(next.sources['daemon-source']?.items ?? {}).toSorted()).deepEqual([KEY_A, KEY_B]);
  });

  it('should make the base what the source holds now: B := theirs for every copied item', () => {
    const previous: CloneBase = {
      version: 1,
      sources: { 'daemon-source': source({ [KEY_A]: item({ digest: 'a'.repeat(64) }) }) },
    };
    const next = applyCloneToBase(
      previous,
      update({
        copied: [entry(KEY_A, { digest: 'b'.repeat(64) })],
        sourceKeys: new Set([KEY_A]),
        model: linkedModel(KEY_A),
      }),
    );
    should(next.sources['daemon-source']?.items[KEY_A]?.digest).equal('b'.repeat(64));
  });

  it('should keep an earlier entry for an item this copy did not write while the source still has it', () => {
    const previous: CloneBase = {
      version: 1,
      sources: { 'daemon-source': source({ [KEY_A]: item(), [KEY_B]: item() }) },
    };
    const next = applyCloneToBase(
      previous,
      update({ copied: [entry(KEY_A)], sourceKeys: new Set([KEY_A, KEY_B]), model: linkedModel(KEY_A) }),
    );
    should(Object.keys(next.sources['daemon-source']?.items ?? {}).toSorted()).deepEqual([KEY_A, KEY_B]);
  });

  describe('garbage collection', () => {
    it('should drop an entry that is gone on both sides: not at the source any more, nothing here links to it', () => {
      const previous: CloneBase = {
        version: 1,
        sources: { 'daemon-source': source({ [KEY_A]: item(), [KEY_B]: item() }) },
      };
      const next = applyCloneToBase(
        previous,
        update({ copied: [], sourceKeys: new Set([KEY_A]), model: linkedModel(KEY_A, KEY_B) }),
      );
      // KEY_B is gone at the source but still linked here: it stays, so "gone from the other machine" can be said.
      should(Object.keys(next.sources['daemon-source']?.items ?? {}).toSorted()).deepEqual([KEY_A, KEY_B]);
      const both = applyCloneToBase(
        previous,
        update({ copied: [], sourceKeys: new Set([KEY_A]), model: linkedModel(KEY_A) }),
      );
      should(Object.keys(both.sources['daemon-source']?.items ?? {})).deepEqual([KEY_A]);
    });

    it('should keep an entry the source still has even when nothing here links to it yet', () => {
      const previous: CloneBase = {
        version: 1,
        sources: { 'daemon-source': source({ [KEY_A]: item(), [KEY_B]: item() }) },
      };
      const next = applyCloneToBase(
        previous,
        update({ copied: [], sourceKeys: new Set([KEY_A, KEY_B]), model: linkedModel(KEY_A) }),
      );
      should(Object.keys(next.sources['daemon-source']?.items ?? {}).toSorted()).deepEqual([KEY_A, KEY_B]);
    });

    it('should keep an entry linked here by a login the copy matched, though the login carries no key', () => {
      const model = parseAccountModel({
        version: 2,
        credentials: { 'claude-you': { harness: 'claude', store: 'host' } },
        components: { instructions: { main: { file: 'components/instructions/main.md', clonedFromKey: KEY_A } } },
      });
      const previous: CloneBase = {
        version: 1,
        sources: {
          'daemon-source': source({ [KEY_A]: item(), [KEY_D]: item({ kind: 'login', login: 'claude-you' }) }),
        },
      };
      const next = applyCloneToBase(previous, update({ copied: [], sourceKeys: new Set([KEY_A]), model }));
      should(Object.keys(next.sources['daemon-source']?.items ?? {}).toSorted()).deepEqual([KEY_A, KEY_D]);
    });

    it('should drop the whole source when nothing here links to it any more', () => {
      const previous: CloneBase = {
        version: 1,
        sources: { 'daemon-source': source({ [KEY_A]: item() }), other: source({ [KEY_B]: item() }) },
      };
      const next = applyCloneToBase(
        previous,
        update({ copied: [], sourceKeys: new Set([KEY_A]), model: linkedModel(KEY_B) }),
      );
      should(Object.keys(next.sources)).deepEqual(['other']);
    });

    it('should drop a source that nothing links to, and drop the others a copy left with nothing', () => {
      const previous: CloneBase = {
        version: 1,
        sources: { 'daemon-source': source({}), stale: source({ [KEY_C]: item() }), kept: source({ [KEY_B]: item() }) },
      };
      const next = applyCloneToBase(previous, update({ model: linkedModel(KEY_B) }));
      should(Object.keys(next.sources)).deepEqual(['kept']);
    });

    it('should evict the source copied longest ago past 32, and never the one just copied', () => {
      const sources = Object.fromEntries(
        Array.from({ length: CLONE_BASE_SOURCES_LIMIT }, (_, index) => {
          const key = `${'abcdefghijklmnopqrstuvwxyz'[index % 26] ?? 'a'}${String(index).padStart(2, '2')}`.padEnd(
            26,
            'a',
          );
          return [
            `s${String(index)}`,
            source({ [key]: item() }, `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
          ];
        }),
      );
      const model = linkedModel(...Object.values(sources).flatMap(each => Object.keys(each.items)), KEY_A);
      const next = applyCloneToBase(
        { version: 1, sources },
        update({ copied: [entry(KEY_A)], sourceKeys: new Set([KEY_A]), model }),
      );
      should(Object.keys(next.sources)).have.length(CLONE_BASE_SOURCES_LIMIT);
      should(next.sources.s0).be.undefined();
      should(next.sources.s1).not.be.undefined();
      should(next.sources['daemon-source']).not.be.undefined();
    });

    it('should not record a source with more items than a source may hold', () => {
      const keyOf = (index: number): string =>
        [...index.toString(6).padStart(26, '0')].map(digit => '234567'[Number(digit)]).join('');
      const copied = Array.from({ length: CLONE_BASE_ITEMS_LIMIT + 1 }, (_, index) => entry(keyOf(index)));
      const next = applyCloneToBase(
        EMPTY_CLONE_BASE,
        update({ copied, sourceKeys: new Set(copied.map(each => each.key)), model: linkedModel(KEY_A) }),
      );
      should(next.sources['daemon-source']).be.undefined();
    });
  });

  describe('Replace', () => {
    it('should rewrite the source from this copy alone, forgetting what an earlier copy recorded', () => {
      const previous: CloneBase = {
        version: 1,
        sources: { 'daemon-source': source({ [KEY_A]: item(), [KEY_B]: item() }) },
      };
      const next = applyCloneToBase(
        previous,
        update({ replace: true, copied: [entry(KEY_C)], sourceKeys: new Set([KEY_C]), model: linkedModel(KEY_C) }),
      );
      should(Object.keys(next.sources['daemon-source']?.items ?? {})).deepEqual([KEY_C]);
    });

    it('should drop another source the Replace left with nothing to link to, and keep one it did not', () => {
      const previous: CloneBase = {
        version: 1,
        sources: { gone: source({ [KEY_D]: item() }), still: source({ [KEY_E]: item() }) },
      };
      const next = applyCloneToBase(
        previous,
        update({
          replace: true,
          copied: [entry(KEY_C)],
          sourceKeys: new Set([KEY_C]),
          model: linkedModel(KEY_C, KEY_E),
        }),
      );
      should(Object.keys(next.sources).toSorted()).deepEqual(['daemon-source', 'still']);
    });
  });

  it('should carry the per-key digests and timestamps an earlier copy filed, untouched', () => {
    const previous = parseCloneBase(
      JSON.stringify({
        version: 1,
        sources: {
          'daemon-source': {
            ...source({ [KEY_A]: item() }),
            settings: { 'warden.yaml': { enabled: DIGEST } },
            keys: { OPENAI_API_KEY: { sourceUpdatedAt: AT, targetUpdatedAt: AT } },
          },
        },
      }),
    );
    should(previous.sources['daemon-source']?.settings).not.be.undefined();
    const next = applyCloneToBase(
      previous,
      update({ copied: [entry(KEY_A)], sourceKeys: new Set([KEY_A]), model: linkedModel(KEY_A) }),
    );
    should(next.sources['daemon-source']?.settings).deepEqual(previous.sources['daemon-source']?.settings);
    should(next.sources['daemon-source']?.keys).deepEqual(previous.sources['daemon-source']?.keys);
  });

  it('should be what parseCloneBase accepts back', () => {
    const next = applyCloneToBase(
      EMPTY_CLONE_BASE,
      update({ copied: [entry(KEY_A)], sourceKeys: new Set([KEY_A]), model: linkedModel(KEY_A) }),
    );
    should(parseCloneBase(serializeCloneBase(next))).deepEqual(next);
  });
});

describe('forgetCloneSource', () => {
  it('should drop one source and nothing else', () => {
    const base: CloneBase = { version: 1, sources: { a: source({}), b: source({}) } };
    should(Object.keys(forgetCloneSource(base, 'a').sources)).deepEqual(['b']);
    should(Object.keys(forgetCloneSource(base, 'nobody').sources)).deepEqual(['a', 'b']);
  });
});

describe('linkedKeys', () => {
  it('should read every origin key the setup carries, from components, profiles, runtimes and logins', () => {
    const plan = planClone(emptyTarget(), V2(), options());
    should(linkedKeys(plan.model)).deepEqual(new Set([KEY_A, KEY_B, KEY_C, KEY_D]));
    should(linkedKeys(emptyTarget()).size).equal(0);
  });
});
