import { describe, it } from 'bun:test';
import { type CloneBundle, CloneBundleSchema } from '../../../contract/index.ts';
import { sha256Hex } from '../../../daemon/lib/foreign.ts';
import should from 'should';
import {
  applyCloneToBase,
  CLONE_BASE_FILES_LIMIT,
  CLONE_BASE_ITEMS_LIMIT,
  CLONE_BASE_SOURCES_LIMIT,
  type CloneBase,
  type CloneBaseEntry,
  type CloneBaseItem,
  cloneOriginKeys,
  cloneSourceIdentity,
  CloneSourceMismatch,
  EMPTY_CLONE_BASE,
  findCloneSources,
  forgetCloneSource,
  SELF_REPORTED_PREFIX,
  linkedKeys,
  parseCloneBase,
  serializeCloneBase,
} from '../../../daemon/lib/account/clone-base.ts';
import { type CloneOptions, planClone } from '../../../daemon/lib/account/clone.ts';
import { type AccountModel, parseAccountModel } from '../../../daemon/lib/account/schema.ts';

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
  credentials: [{ id: 'claude-you', harness: 'claude-code', label: 'you', email: 'person@example.test' }],
  components: { instructions: { main: { file: 'components/instructions/main.md' } } },
  profiles: { default: { layers: ['instructions/main'] } },
  runtimes: { 'claude-default': { credential: 'claude-you', profile: 'default', agent: false } },
  files: [{ path: 'components/instructions/main.md', content: '# Main' }],
  notCopied: [],
};

const KEYS = {
  'instructions/main': KEY_A,
  'profile/default': KEY_B,
  'runtime/claude-default': KEY_C,
  'login/claude-you': KEY_D,
};
const bundleOf = (patch: Record<string, unknown> = {}): CloneBundle =>
  CloneBundleSchema.parse({ ...bundleShape, version: 1, daemon: 'daemon-source', keys: KEYS, ...patch });

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
const linkedModel = (...keys: string[]): AccountModel => linkedModelFrom(undefined, ...keys);

/** As {@link linkedModel}, the items stamped with the daemon id a browser verified for their source. */
const linkedModelFrom = (daemon: string | undefined, ...keys: string[]): AccountModel =>
  parseAccountModel({
    version: 2,
    components: {
      instructions: Object.fromEntries(
        keys.map((key, index) => [
          `item${String(index)}`,
          {
            file: `components/instructions/${String(index)}.md`,
            clonedFromKey: key,
            ...(daemon === undefined ? {} : { clonedFromDaemon: daemon }),
          },
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
  it('should file a bundle under what it said of itself, as unverified, in a namespace of its own', () => {
    should(cloneSourceIdentity(bundleOf(), undefined, undefined)).deepEqual({
      id: `${SELF_REPORTED_PREFIX}daemon-source`,
      name: 'studio-mac',
      verified: 'self',
      machine: 'studio-mac',
    });
  });

  it('should prefer the id the browser verified when it agrees with the bundle', () => {
    should(cloneSourceIdentity(bundleOf(), 'daemon-source', undefined)?.verified).equal('browser');
  });

  it('should refuse a bundle that names another machine than the one picked', () => {
    const attempt = (): unknown => cloneSourceIdentity(bundleOf(), 'daemon-other', undefined);
    should(attempt).throw(CloneSourceMismatch);
    should(attempt).throw('That export says it is from another machine than the one you picked.');
  });

  it('should read an oversized self-reported id as no identity, and refuse it beside a verified id', () => {
    const huge = { ...bundleOf(), daemon: 'd'.repeat(201) } as CloneBundle;
    should(cloneSourceIdentity(huge, undefined, undefined)).be.undefined();
    should(() => cloneSourceIdentity(huge, 'daemon-source', undefined)).throw(CloneSourceMismatch);
  });

  it('should never file what a bundle says of itself under an id the browser could have verified', () => {
    // Act
    const reported = cloneSourceIdentity(bundleOf(), undefined, undefined);
    const verified = cloneSourceIdentity(bundleOf(), 'daemon-source', undefined);

    // Assert
    should(reported?.id).not.equal(verified?.id);
    should(verified?.id).equal('daemon-source');
  });

  it('should say an over-long id is too long, not that the export is from another machine', () => {
    // Arrange
    const huge = 'd'.repeat(201);
    const bundle = { ...bundleOf(), daemon: huge } as CloneBundle;

    // Act + Assert
    should(() => cloneSourceIdentity(bundle, huge, undefined)).throw(CloneSourceMismatch);
    should(() => cloneSourceIdentity(bundle, huge, undefined)).throw(
      'That export names its machine with an id too long to remember. Export it again from the other machine.',
    );
  });

  it('should read a self-reported id with no room for its namespace as no identity', () => {
    // Arrange
    const bundle = { ...bundleOf(), daemon: 'd'.repeat(200) } as CloneBundle;

    // Act + Assert
    should(cloneSourceIdentity(bundle, undefined, undefined)).be.undefined();
  });

  it.each([
    { length: 195, verified: undefined, identified: true },
    { length: 196, verified: undefined, identified: false },
    { length: 200, verified: undefined, identified: false },
    { length: 195, verified: 'browser', identified: true },
    { length: 196, verified: 'browser', identified: true },
    { length: 200, verified: 'browser', identified: true },
  ])(
    'should give a $length character id an identity: $identified, when verified is $verified',
    ({ length, verified, identified }) => {
      // Arrange
      const id = 'd'.repeat(length);
      const bundle = { ...bundleOf(), daemon: id } as CloneBundle;

      // Act
      const identity = cloneSourceIdentity(bundle, verified === undefined ? undefined : id, undefined);

      // Assert
      should(identity !== undefined).equal(identified);
      if (identity !== undefined) should(identity.verified).equal(verified === undefined ? 'self' : 'browser');
    },
  );

  it('should refuse an id of 201 characters beside the same verified id, and give it no identity alone', () => {
    // Arrange
    const id = 'd'.repeat(201);
    const bundle = { ...bundleOf(), daemon: id } as CloneBundle;

    // Act + Assert
    should(() => cloneSourceIdentity(bundle, id, undefined)).throw(CloneSourceMismatch);
    should(cloneSourceIdentity(bundle, undefined, undefined)).be.undefined();
  });

  it('should cut a display name to 120 characters', () => {
    should(cloneSourceIdentity(bundleOf(), undefined, 'x'.repeat(300))?.name).have.length(120);
  });

  it('should name the machine only for a source filed from its own word, and only when the record can hold it', () => {
    should(cloneSourceIdentity(bundleOf(), 'daemon-source', 'Studio')?.machine).be.undefined();
    should(cloneSourceIdentity(bundleOf({ machine: 'm'.repeat(121) }), undefined, undefined)?.machine).be.undefined();
  });
});

describe('cloneOriginKeys', () => {
  it('should take the keys of items the bundle has', () => {
    should([...cloneOriginKeys(bundleOf())]).deepEqual(Object.entries(KEYS));
  });

  it('should drop a key two items claim, and a key for an item the bundle does not have', () => {
    const keys = cloneOriginKeys(bundleOf({ keys: { ...KEYS, 'profile/default': KEY_A, 'mcp/ghost': KEY_E } }));
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

  it('should stamp every item a copy writes with the key the source gave it', () => {
    const plan = planClone(emptyTarget(), bundleOf(), options());
    should(stamps(plan.model).toSorted()).deepEqual([KEY_A, KEY_B, KEY_C, KEY_D]);
  });

  it('should replace a key the source claimed on its own items with the one the bundle carries', () => {
    const claimed = bundleOf({
      components: { instructions: { main: { file: 'components/instructions/main.md', clonedFromKey: KEY_E } } },
    });
    const model = planClone(emptyTarget(), claimed, options()).model;
    should(Object.values(model.components.instructions)[0]?.clonedFromKey).equal(KEY_A);
  });

  it('should record the source side of every copied item, computed here, with its documents', () => {
    const plan = planClone(emptyTarget(), bundleOf(), options());
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
    const digestOf = (bundle: CloneBundle): string | undefined =>
      planClone(emptyTarget(), bundle, options()).base.find(each => each.key === KEY_A)?.digest;
    const changed = bundleOf({ files: [{ path: 'components/instructions/main.md', content: '# Main, edited' }] });
    should(digestOf(changed)).not.equal(digestOf(bundleOf()));
    const sameButOtherMachine = bundleOf({ machine: 'another-name' });
    should(digestOf(sameButOtherMachine)).equal(digestOf(bundleOf()));
  });

  it('should name the login here a source login was matched to', () => {
    const plan = planClone(emptyTarget(), bundleOf(), options());
    const login = plan.base.find(each => each.key === KEY_D);
    should(Object.keys(plan.model.credentials)).containEql(login?.login);
  });

  it('should leave a skipped component out of what it records, yet keep its key as one the source holds', () => {
    const plan = planClone(emptyTarget(), bundleOf(), options({ skip: ['instructions/main'] }));
    should(plan.base.some(each => each.key === KEY_A)).be.false();
    should(plan.sourceKeys.has(KEY_A)).be.true();
  });
});

describe('the per-key settings digests', () => {
  const D1 = '1'.repeat(64);
  const D2 = '2'.repeat(64);
  const D3 = '3'.repeat(64);

  it('should be filed per document, replace only the documents a copy decided, and keep the rest', () => {
    const previous: CloneBase = {
      version: 1,
      sources: {
        'daemon-source': {
          ...source({ [KEY_A]: item() }),
          settings: { 'warden.yaml': { 'layers.jev': D1 }, 'voice.yaml': { 'postProcessing.provider': D2 } },
        },
      },
    };
    const next = applyCloneToBase(
      previous,
      update({
        copied: [entry(KEY_A)],
        sourceKeys: new Set([KEY_A]),
        model: linkedModel(KEY_A),
        settings: { 'warden.yaml': { 'layers.jev': D3, intervalMinutes: D1 } },
      }),
    );
    should(next.sources['daemon-source']?.settings).deepEqual({
      'warden.yaml': { 'layers.jev': D3, intervalMinutes: D1 },
      'voice.yaml': { 'postProcessing.provider': D2 },
    });
  });

  it('should keep a source alive on its settings alone, and start over on Replace', () => {
    const settingsOnly = update({ settings: { controls: { defaultRuntime: D1 } } });
    const first = applyCloneToBase(EMPTY_CLONE_BASE, settingsOnly);
    should(first.sources['daemon-source']?.settings).deepEqual({ controls: { defaultRuntime: D1 } });
    // Not a different source's: another source's settings never reach this one.
    const other = applyCloneToBase(first, update({ source: { id: 'daemon-two', name: 'two', verified: 'self' } }));
    should(Object.keys(other.sources)).deepEqual(['daemon-source']);
    const replaced = applyCloneToBase(first, update({ replace: true, settings: { 'voice.yaml': { x: D2 } } }));
    should(replaced.sources['daemon-source']?.settings).deepEqual({ 'voice.yaml': { x: D2 } });
  });

  it('should drop a source with no items and no settings, as before', () => {
    should(applyCloneToBase(EMPTY_CLONE_BASE, update({})).sources).deepEqual({});
    should(applyCloneToBase(EMPTY_CLONE_BASE, update({ settings: { 'warden.yaml': {} } })).sources).deepEqual({});
  });

  it('should read back what serializeCloneBase wrote, in order, and hold only digests', () => {
    const base: CloneBase = {
      version: 1,
      sources: { s: { ...source({}), settings: { 'warden.yaml': { b: D2, a: D1 }, controls: { z: D3 } } } },
    };
    const text = serializeCloneBase(base);
    should(parseCloneBase(text)).deepEqual(base);
    should(serializeCloneBase(parseCloneBase(text))).equal(text);
    should(Object.keys(JSON.parse(text).sources.s.settings['warden.yaml'])).deepEqual(['a', 'b']);
  });

  it.each([
    ['a value instead of a digest', { 'warden.yaml': { a: 'enabled: true' } }],
    ['a document that is not one a copy merges', { 'machine.yaml': { a: D1 } }],
    ['an empty key', { 'warden.yaml': { '': D1 } }],
  ])('should read a record holding %s as absent', (_name, settings) => {
    const text = JSON.stringify({ version: 1, sources: { s: { ...source({}), settings } } });
    should(parseCloneBase(text)).deepEqual(EMPTY_CLONE_BASE);
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

describe('findCloneSources', () => {
  const base: CloneBase = {
    version: 1,
    sources: {
      'daemon-a': { ...source({}), name: 'Studio' },
      'self:daemon-b': { ...source({}), name: 'Laptop', machine: 'studio-mac' },
      'self:daemon-c': { ...source({}), name: 'Studio' },
    },
  };

  it('should find a source by the id as filed, or by the bare id an export carries', () => {
    should(findCloneSources(base, 'daemon-a')).deepEqual(['daemon-a']);
    should(findCloneSources(base, 'self:daemon-b')).deepEqual(['self:daemon-b']);
    should(findCloneSources(base, 'daemon-b')).deepEqual(['self:daemon-b']);
  });

  it('should find a source by the name it was copied under or the machine name its export gave', () => {
    should(findCloneSources(base, 'Laptop')).deepEqual(['self:daemon-b']);
    should(findCloneSources(base, 'studio-mac')).deepEqual(['self:daemon-b']);
  });

  it('should answer every source a name fits, and none for a word that fits nothing', () => {
    should(findCloneSources(base, 'Studio')).deepEqual(['daemon-a', 'self:daemon-c']);
    should(findCloneSources(base, 'nobody')).deepEqual([]);
  });

  it('should take an exact id over a name that happens to be the same word', () => {
    const tricky: CloneBase = {
      version: 1,
      sources: { Studio: source({}), other: { ...source({}), name: 'Studio' } },
    };
    should(findCloneSources(tricky, 'Studio')).deepEqual(['Studio']);
  });
});

describe('linkedKeys', () => {
  it('should read every origin key the setup carries, from components, profiles, runtimes and logins', () => {
    const plan = planClone(emptyTarget(), bundleOf(), options());
    should(linkedKeys(plan.model)).deepEqual(new Set([KEY_A, KEY_B, KEY_C, KEY_D]));
    should(linkedKeys(emptyTarget()).size).equal(0);
  });
});

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** An item whose document list is longer than one item may list. */
const oversizeItem = (): CloneBaseItem =>
  item({
    files: Object.fromEntries(
      Array.from({ length: CLONE_BASE_FILES_LIMIT + 1 }, (_, index) => [
        `components/skills/big/f${String(index)}.md`,
        { digest: DIGEST, bytes: 1 },
      ]),
    ),
  });

describe('serializeCloneBase: a record that always reads back', () => {
  it('should leave out the documents of an item that lists too many, and keep every source', () => {
    // Arrange
    const honest = source({ [KEY_A]: item() });
    const base: CloneBase = {
      version: 1,
      sources: {
        honest,
        big: source({
          [KEY_B]: oversizeItem(),
          [KEY_C]: item({ files: { 'components/x.md': { digest: DIGEST, bytes: 1 } } }),
        }),
      },
    };

    // Act
    const read = parseCloneBase(serializeCloneBase(base));

    // Assert
    should(Object.keys(read.sources).toSorted()).deepEqual(['big', 'honest']);
    should(read.sources.honest).deepEqual(honest);
    should(read.sources.big?.items[KEY_B]).deepEqual(item());
    should(read.sources.big?.items[KEY_C]?.files).deepEqual({ 'components/x.md': { digest: DIGEST, bytes: 1 } });
  });

  it('should drop a source with more items than one source may hold, and keep the others', () => {
    // Arrange
    const items = Object.fromEntries(
      Array.from({ length: CLONE_BASE_ITEMS_LIMIT + 1 }, (_, index) => [
        `${'a'.repeat(22)}${[...index.toString(32).padStart(4, '0')].map(digit => BASE32[Number.parseInt(digit, 32)]).join('')}`,
        item(),
      ]),
    );
    const base: CloneBase = { version: 1, sources: { huge: source(items), small: source({ [KEY_A]: item() }) } };

    // Act
    const read = parseCloneBase(serializeCloneBase(base));

    // Assert
    should(Object.keys(read.sources)).deepEqual(['small']);
  });

  it('should keep the newest 32 sources of a record with more, rather than none', () => {
    // Arrange
    const sources = Object.fromEntries(
      Array.from({ length: CLONE_BASE_SOURCES_LIMIT + 3 }, (_, index) => [
        `s${String(index).padStart(2, '0')}`,
        source({}, `2026-10-01T00:${String(index).padStart(2, '0')}:00.000Z`),
      ]),
    );

    // Act
    const read = parseCloneBase(serializeCloneBase({ version: 1, sources }));

    // Assert
    should(Object.keys(read.sources)).have.length(CLONE_BASE_SOURCES_LIMIT);
    should(read.sources.s00).be.undefined();
    should(read.sources.s34).not.be.undefined();
  });

  it('should leave a source filed under __proto__ out, with every other source still reading back', () => {
    // Arrange
    const base = applyCloneToBase(
      { version: 1, sources: { fine: source({ [KEY_B]: item() }) } },
      update({
        source: { id: '__proto__', name: 'odd', verified: 'browser' },
        copied: [entry(KEY_A)],
        sourceKeys: new Set([KEY_A]),
        model: linkedModel(KEY_A, KEY_B),
      }),
    );

    // Act
    const read = parseCloneBase(serializeCloneBase(base));

    // Assert
    should(Object.keys(read.sources)).deepEqual(['fine']);
  });

  it('should give a source whose verified id is __proto__ no identity at all', () => {
    // Act + Assert
    should(cloneSourceIdentity({ ...bundleOf(), daemon: '__proto__' } as CloneBundle, undefined, undefined)?.id).equal(
      `${SELF_REPORTED_PREFIX}__proto__`,
    );
  });
});

describe('applyCloneToBase: a source is only ever its own entry', () => {
  const copiedFrom = (id: string, verified: 'browser' | 'self', digest: string, replace = false) =>
    update({
      source: { id, name: id, verified },
      replace,
      copied: [entry(KEY_A, { digest })],
      sourceKeys: new Set([KEY_A]),
      model: linkedModel(KEY_A),
    });

  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'should not find an inherited property when %p is a new source',
    id => {
      // Act
      const next = applyCloneToBase(EMPTY_CLONE_BASE, copiedFrom(id, 'browser', 'a'.repeat(64)));

      // Assert
      should(Object.keys(next.sources)).deepEqual([id]);
      should(Object.hasOwn(next.sources, id)).be.true();
      should(Object.keys(next.sources[id]?.items ?? {})).deepEqual([KEY_A]);
    },
  );

  it('should leave the record exactly as it was when a self-reported id equals a browser-verified one', () => {
    // Arrange
    const verified = applyCloneToBase(EMPTY_CLONE_BASE, copiedFrom('daemon-a', 'browser', 'a'.repeat(64)));
    const before = serializeCloneBase(verified);

    // Act
    const merged = applyCloneToBase(verified, copiedFrom('daemon-a', 'self', 'b'.repeat(64)));
    const rewritten = applyCloneToBase(verified, copiedFrom('daemon-a', 'self', 'b'.repeat(64), true));

    // Assert
    should(serializeCloneBase(merged)).equal(before);
    should(serializeCloneBase(rewritten)).equal(before);
    should(merged.sources['daemon-a']?.verified).equal('browser');
    should(merged.sources['daemon-a']?.items[KEY_A]?.digest).equal('a'.repeat(64));
  });

  it('should start a verified copy afresh over an entry that was only self-reported', () => {
    // Arrange
    const planted = applyCloneToBase(
      EMPTY_CLONE_BASE,
      update({
        source: { id: 'daemon-a', name: 'daemon-a', verified: 'self' },
        copied: [entry(KEY_A), entry(KEY_B)],
        sourceKeys: new Set([KEY_A, KEY_B]),
        model: linkedModel(KEY_A, KEY_B),
      }),
    );

    // Act
    const next = applyCloneToBase(
      planted,
      update({
        source: { id: 'daemon-a', name: 'daemon-a', verified: 'browser' },
        copied: [entry(KEY_A)],
        sourceKeys: new Set([KEY_A]),
        model: linkedModel(KEY_A, KEY_B),
      }),
    );

    // Assert
    should(next.sources['daemon-a']?.verified).equal('browser');
    should(Object.keys(next.sources['daemon-a']?.items ?? {})).deepEqual([KEY_A]);
  });

  it('should not keep one source alive because another source stamped the same key on its items', () => {
    // Arrange: source A recorded KEY_A, and nothing but a copy from B (which claims KEY_A) now carries it
    const previous: CloneBase = { version: 1, sources: { a: source({ [KEY_A]: item() }) } };

    // Act
    const next = applyCloneToBase(
      previous,
      update({
        source: { id: 'b', name: 'b', verified: 'browser' },
        copied: [entry(KEY_A)],
        sourceKeys: new Set([KEY_A]),
        model: linkedModelFrom('b', KEY_A),
      }),
    );

    // Assert
    should(Object.keys(next.sources)).deepEqual(['b']);
  });

  it('should keep a browser-verified source whose copy sits beside a copy of the same bundle made from a file', () => {
    // Arrange: a browser copy from "a", then the same bundle copied from a file (it names itself "a" too)
    const bundle = bundleOf({
      daemon: 'a',
      credentials: [],
      profiles: {},
      runtimes: {},
      keys: { 'instructions/main': KEY_A },
    });
    const browser = cloneSourceIdentity(bundle, 'a', undefined);
    const file = cloneSourceIdentity(bundle, undefined, undefined);
    if (browser === undefined || file === undefined) throw new Error('both copies have an identity');
    const first = planClone(emptyTarget(), bundle, options({ sourceDaemon: 'a' }));
    const afterBrowser = applyCloneToBase(
      EMPTY_CLONE_BASE,
      update({ source: browser, copied: first.base, sourceKeys: first.sourceKeys, model: first.model }),
    );
    const second = planClone(first.model, bundle, options());

    // Act
    const next = applyCloneToBase(
      afterBrowser,
      update({ source: file, copied: second.base, sourceKeys: second.sourceKeys, model: second.model }),
    );

    // Assert: both copies are in the setup, and each source keeps a record of its own items
    should(Object.keys(second.model.components.instructions).toSorted()).deepEqual(['main', 'main-2']);
    should(second.model.components.instructions.main?.clonedFromDaemon).equal('a');
    should(second.model.components.instructions['main-2']?.clonedFromDaemon).be.undefined();
    should(Object.keys(next.sources).toSorted()).deepEqual(['a', `${SELF_REPORTED_PREFIX}a`]);
    should(next.sources.a).deepEqual(afterBrowser.sources.a);
    should(next.sources.a?.verified).equal('browser');
    should(Object.keys(next.sources.a?.items ?? {})).deepEqual([KEY_A]);
    should(Object.keys(next.sources[`${SELF_REPORTED_PREFIX}a`]?.items ?? {})).deepEqual([KEY_A]);
  });

  it('should drop a source from a file once only a browser copy of the same keys is left', () => {
    // Arrange
    const previous: CloneBase = {
      version: 1,
      sources: { a: { ...source({ [KEY_A]: item() }), verified: 'browser' }, 'self:a': source({ [KEY_A]: item() }) },
    };

    // Act: the only item left was copied by the browser from "a"
    const next = applyCloneToBase(
      previous,
      update({
        source: { id: 'a', name: 'a', verified: 'browser' },
        copied: [],
        sourceKeys: new Set([KEY_A]),
        model: linkedModelFrom('a', KEY_A),
      }),
    );

    // Assert
    should(Object.keys(next.sources)).deepEqual(['a']);
  });

  describe('two sources copied from a file, sharing a key (#1383 nit 6)', () => {
    /** A components-only bundle from `machine`, copied from a file (no id a browser verified). */
    const fromFile = (machine: string) => {
      const bundle = bundleOf({
        daemon: machine,
        machine,
        credentials: [],
        profiles: {},
        runtimes: {},
        keys: { 'instructions/main': KEY_A },
      });
      const identity = cloneSourceIdentity(bundle, undefined, undefined);
      if (identity === undefined) throw new Error('a bundle has an identity');
      return { bundle, identity };
    };
    const copy = (previous: CloneBase, model: AccountModel, machine: string, mode: 'alongside' | 'replace') => {
      const { bundle, identity } = fromFile(machine);
      const plan = planClone(model, bundle, options({ mode }));
      return {
        model: plan.model,
        record: applyCloneToBase(
          previous,
          update({
            source: identity,
            replace: mode === 'replace',
            copied: plan.base,
            sourceKeys: plan.sourceKeys,
            model: plan.model,
          }),
        ),
      };
    };

    it('should keep only the source a Replace copied from, not the one it replaced', () => {
      // Arrange: a copy from a, then a Replace from b whose bundle carries the same key.
      const first = copy(EMPTY_CLONE_BASE, emptyTarget(), 'a', 'alongside');
      should(Object.keys(first.record.sources)).deepEqual([`${SELF_REPORTED_PREFIX}a`]);

      // Act
      const next = copy(first.record, first.model, 'b', 'replace');

      // Assert
      should(Object.keys(next.model.components.instructions)).deepEqual(['main']);
      should(next.model.components.instructions.main?.clonedFrom).equal('b');
      should(Object.keys(next.record.sources)).deepEqual([`${SELF_REPORTED_PREFIX}b`]);
      should(next.record.sources[`${SELF_REPORTED_PREFIX}b`]?.machine).equal('b');
    });

    it('should keep both when both copies are still here', () => {
      const first = copy(EMPTY_CLONE_BASE, emptyTarget(), 'a', 'alongside');
      const next = copy(first.record, first.model, 'b', 'alongside');
      should(Object.keys(next.model.components.instructions).toSorted()).deepEqual(['main', 'main-2']);
      should(Object.keys(next.record.sources).toSorted()).deepEqual([
        `${SELF_REPORTED_PREFIX}a`,
        `${SELF_REPORTED_PREFIX}b`,
      ]);
    });
  });

  it('should keep another source whose own items are still linked here', () => {
    // Arrange
    const previous: CloneBase = { version: 1, sources: { a: source({ [KEY_B]: item() }) } };

    // Act
    const next = applyCloneToBase(
      previous,
      update({
        source: { id: 'b', name: 'b', verified: 'browser' },
        copied: [entry(KEY_A)],
        sourceKeys: new Set([KEY_A]),
        model: linkedModel(KEY_A, KEY_B),
      }),
    );

    // Assert
    should(Object.keys(next.sources).toSorted()).deepEqual(['a', 'b']);
  });
});
