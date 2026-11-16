import { describe, expect, test } from 'bun:test';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import { err, ok } from '@ferretry/std';
import { SHELL_CODES, ShellItemSchema, ShellLockSchema } from '../../contract/index.ts';
import { buildKey, cacheName } from '../../daemon/lib/source.ts';
import { flakeFacts, HASH_A, HASH_B, REV_A, REV_B, shellsHarness } from './support.ts';

const lockedRef = `github:me/shells/${REV_A}#web`;
const webItem = { flake: lockedRef };

/** The pinned address the item is written with is what a later resolve asks about, so both answer. */
function setMetadata(h: ReturnType<typeof shellsHarness>, facts: ReturnType<typeof flakeFacts>) {
  h.nix.metadata.set(`github:me/shells/${REV_A}`, facts);
  h.nix.metadata.set(flakeFacts().url, facts);
}

function withWeb(options: Parameters<typeof shellsHarness>[0] = {}) {
  const h = shellsHarness(options);
  setMetadata(h, flakeFacts());
  return h;
}

describe('adding a shell', () => {
  test('a locked flake is resolved, written pinned with its narHash, locked, and announced', async () => {
    const h = withWeb();
    const result = await h.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.held).toBeUndefined();
    expect(ShellLockSchema.safeParse(result.value.lock).success).toBe(true);
    expect(result.value.lock.source).toMatchObject({ kind: 'flake', rev: REV_A, narHash: HASH_A });
    const written = Bun.YAML.parse(h.tree.calls[0]?.text as string) as { flake: string };
    expect(written.flake).toBe(`${flakeFacts().url}#web`);
    expect(h.tree.calls[0]?.where).toBe('shells/web');
    expect(h.published).toEqual([{ event: 'shells.changed', payload: { name: 'web' } }]);
  });

  test('a flake with no revision is refused unless it says floating, and nothing is written', async () => {
    const h = withWeb();
    const refused = await h.service.add({
      name: 'web',
      item: ShellItemSchema.parse({ flake: 'github:me/shells#web' }),
    });
    expect(!refused.ok && refused.refusal).toMatchObject({ status: 422, code: SHELL_CODES.unlocked });
    expect(h.tree.calls).toEqual([]);
    expect(h.nix.asked).toEqual([]);
  });

  test('a floating flake is resolved now and stays floating in its file', async () => {
    const h = shellsHarness();
    h.nix.metadata.set('github:me/shells', flakeFacts());
    const result = await h.service.add({
      name: 'web',
      item: ShellItemSchema.parse({ flake: 'github:me/shells#web', floating: true }),
    });
    expect(result.ok && result.value.lock.floating).toBe(true);
    expect((Bun.YAML.parse(h.tree.calls[0]?.text as string) as { flake: string }).flake).toBe('github:me/shells#web');
  });

  test('a package list is pinned to the nixpkgs nix resolves now, and the pin is written into the item', async () => {
    const h = shellsHarness();
    h.nix.metadata.set('nixpkgs', flakeFacts(REV_B, HASH_B, 'github:NixOS/nixpkgs'));
    const result = await h.service.add({ name: 'tools', item: ShellItemSchema.parse({ packages: ['git', 'jq'] }) });
    expect(result.ok && result.value.lock.source).toMatchObject({
      kind: 'packages',
      packages: ['git', 'jq'],
      nixpkgs: { rev: REV_B, narHash: HASH_B },
    });
    expect(Bun.YAML.parse(h.tree.calls[0]?.text as string)).toMatchObject({
      packages: ['git', 'jq'],
      nixpkgs: { rev: REV_B },
    });
  });

  test('a package list that names its nixpkgs does not ask nix which one', async () => {
    const h = shellsHarness();
    await h.service.add({
      name: 'tools',
      item: ShellItemSchema.parse({ packages: ['git'], nixpkgs: { rev: REV_B, narHash: HASH_B } }),
    });
    expect(h.nix.asked).toEqual([]);
  });

  test('a shell that is new is held for the owner without activating its lock', async () => {
    const h = withWeb({ hold: ['a new shell will build x'] });
    const result = await h.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    expect(result.ok && result.value.held).toEqual(['a new shell will build x']);
    expect(result.ok && result.value.lock.name).toBe('web');
    expect(h.state.files.has('locks/web.json')).toBe(false);
  });

  test('a name already taken is a conflict; no nix is a conflict that says what to do', async () => {
    const taken = withWeb({ initial: { 'shells/web': { flake: lockedRef } } });
    expect((await taken.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) })).ok).toBe(false);
    const result = await taken.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    expect(!result.ok && result.refusal.code).toBe(SHELL_CODES.exists);

    const noNix = withWeb();
    noNix.nix.facts_ = { present: false, consequence: 'ferrets use the machine’s tools', remedy: 'install nix' };
    const refused = await noNix.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    expect(!refused.ok && refused.refusal).toMatchObject({ status: 409, code: SHELL_CODES.noNix });
    expect(!refused.ok && refused.refusal.sentence).toContain('install nix');
  });

  test('a source nix cannot read is refused with nix’s own words and nothing is written', async () => {
    const h = shellsHarness();
    const result = await h.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    expect(!result.ok && result.refusal).toMatchObject({ status: 422, code: SHELL_CODES.invalid });
    expect(h.tree.calls).toEqual([]);
  });
});

describe('preview', () => {
  test('shows the lock and writes nothing; shows what it changed from when the hash moved', async () => {
    const h = withWeb();
    const first = await h.service.preview({ name: 'web', item: ShellItemSchema.parse(webItem) });
    expect(first.ok && first.value.changedFrom).toBeUndefined();
    expect(h.tree.calls).toEqual([]);
    expect(h.state.files.size).toBe(0);

    await h.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    setMetadata(h, flakeFacts(REV_A, HASH_B));
    const second = await h.service.preview({ name: 'web', item: ShellItemSchema.parse(webItem) });
    expect(second.ok && second.value.changedFrom).toBe(HASH_A);
  });
});

describe('relock', () => {
  test('a pinned shell whose address now names other bytes is refused and keeps its lock', async () => {
    const h = withWeb();
    await h.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    setMetadata(h, flakeFacts(REV_A, HASH_B));
    const result = await h.service.relock('web', { expectedHash: HASH_B });
    expect(!result.ok && result.refusal).toMatchObject({ status: 409, code: SHELL_CODES.hashChanged });
    const lock = h.state.files.get('locks/web.json') as { source: { narHash: string } };
    expect(lock.source.narHash).toBe(HASH_A);
  });

  test('a floating shell takes the new hash on relock and says what it changed from', async () => {
    const h = shellsHarness({ initial: { 'shells/web': { flake: 'github:me/shells#web', floating: true } } });
    h.nix.metadata.set('github:me/shells', flakeFacts(REV_A, HASH_A));
    await h.service.relock('web', { expectedHash: HASH_A });
    h.nix.metadata.set('github:me/shells', flakeFacts(REV_B, HASH_B));
    const result = await h.service.relock('web', { expectedHash: HASH_B });
    expect(result.ok && result.value.changedFrom).toBe(HASH_A);
    expect((h.state.files.get('locks/web.json') as { source: { narHash: string } }).source.narHash).toBe(HASH_B);
  });

  test('an unknown shell is 404', async () => {
    const result = await shellsHarness().service.relock('nope', { expectedHash: HASH_A });
    expect(!result.ok && result.refusal.status).toBe(404);
  });
});

describe('build and cache', () => {
  test('a shell builds once, is cached by its pins, then answers cached; the build is announced once', async () => {
    const h = withWeb();
    await h.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    h.published.length = 0;
    const first = await h.service.build('web');
    const second = await h.service.build('web');
    expect(first.ok && first.value.outcome).toBe('built');
    expect(second.ok && second.value.outcome).toBe('cached');
    expect(h.nix.builds).toBe(1);
    expect(h.published.map(event => event.event)).toEqual(['shells.built']);
    const lock = ShellLockSchema.parse(h.state.files.get('locks/web.json'));
    expect(h.state.files.has(`cache/${cacheName(buildKey(lock))}`)).toBe(true);
    expect((await h.service.list())[0]).toMatchObject({ name: 'web', build: 'built', locked: true, narHash: HASH_A });
  });

  test('two builds asked at once run nix once', async () => {
    const h = withWeb();
    await h.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    const [a, b] = await Promise.all([h.service.build('web'), h.service.build('web')]);
    expect(a.ok && b.ok).toBe(true);
    expect(h.nix.builds).toBe(1);
  });

  test('a failed build is 500 with nix’s words, is shown as failed, and is tried again next time', async () => {
    const h = withWeb();
    await h.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    h.nix.env = err('error: attribute web missing');
    const result = await h.service.build('web');
    expect(!result.ok && result.refusal).toMatchObject({ status: 500, code: SHELL_CODES.buildFailed });
    expect(!result.ok && result.refusal.sentence).toContain('attribute web missing');
    expect((await h.service.list())[0]?.build).toBe('failed');
    h.nix.env = ok({ PATH: '/p' });
    expect((await h.service.build('web')).ok).toBe(true);
    expect((await h.service.list())[0]?.build).toBe('built');
  });

  test('an unlocked shell cannot build; an unknown one is 404', async () => {
    const h = shellsHarness({ initial: { 'shells/web': { flake: lockedRef } } });
    const unlocked = await h.service.build('web');
    expect(!unlocked.ok && unlocked.refusal.code).toBe(SHELL_CODES.unlocked);
    const unknown = await h.service.build('nope');
    expect(!unknown.ok && unknown.refusal.status).toBe(404);
  });
});

describe('remove and read', () => {
  test('removing drops the item and the lock but keeps the cache (it is content-addressed)', async () => {
    const h = withWeb();
    await h.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    await h.service.build('web');
    const cacheKeys = [...h.state.files.keys()].filter(key => key.startsWith('cache/'));
    expect((await h.service.remove('web')).ok).toBe(true);
    expect(h.tree.calls.at(-1)).toEqual({ op: 'remove', where: 'shells/web' });
    expect(h.state.files.has('locks/web.json')).toBe(false);
    expect([...h.state.files.keys()].filter(key => key.startsWith('cache/'))).toEqual(cacheKeys);
    expect((await h.service.remove('web')).ok).toBe(false);
  });

  test('get returns the item, its lock and its summary; a shell with no lock says so', async () => {
    const h = withWeb();
    await h.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    const detail = await h.service.get('web');
    expect(detail?.lock?.name).toBe('web');
    expect(detail?.summary.kind).toBe('flake');
    const bare = shellsHarness({ initial: { 'shells/web': { packages: ['git'] } } });
    expect((await bare.service.get('web'))?.lock).toBeUndefined();
    expect(await bare.service.get('nope')).toBeUndefined();
  });
});

describe('launch parts (Q18: a ferret enters a shell only when its runtime names one)', () => {
  test('a runtime that names no shell gets nothing, and nix is not even asked', async () => {
    const h = withWeb();
    await h.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    h.nix.asked.length = 0;
    expect(await h.service.launchParts('claude-default')).toEqual([]);
    expect(await h.service.launchParts(undefined)).toEqual([]);
    expect(h.nix.builds).toBe(0);
  });

  test('a runtime whose shell exists gets the shell’s environment, building it on first use', async () => {
    const h = withWeb();
    await h.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    const parts = await h.service.launchParts('web');
    expect(parts).toEqual([{ kind: 'shell', name: 'web', env: { PATH: '/nix/store/x/bin:/usr/bin', GIT_SSL: 'x' } }]);
    await h.service.launchParts('web');
    expect(h.nix.builds).toBe(1);
  });

  test('when the shell cannot be had the ferret is told so in words and still starts', async () => {
    const noNix = withWeb();
    await noNix.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    noNix.nix.facts_ = { present: false, consequence: 'c', remedy: 'r' };
    const missing = await noNix.service.launchParts('web');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ kind: 'instruction', id: 'shell-web' });

    const unlocked = shellsHarness({ initial: { 'shells/web': { packages: ['git'] } } });
    expect((await unlocked.service.launchParts('web'))[0]).toMatchObject({ kind: 'instruction' });

    const broken = withWeb();
    await broken.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    broken.nix.env = err('boom');
    const failedBuild = await broken.service.launchParts('web');
    expect(failedBuild[0]).toMatchObject({ kind: 'instruction' });
    expect(JSON.stringify(failedBuild)).not.toContain('boom');
  });
});

for (const yes of [false, true]) {
  test(`a branch advancing after CLI preview never installs or builds the unpreviewed hash (--yes=${yes})`, async () => {
    const { default: cli } = await import('../../cli/index.ts');
    const { default: manifest } = await import('../../manifest.ts');
    const h = shellsHarness({
      initial: { 'shells/web': { flake: 'github:me/shells#web', floating: true, approvedHash: HASH_A } },
    });
    h.nix.metadata.set('github:me/shells', flakeFacts());
    await h.service.relock('web', { expectedHash: HASH_A });
    const client: import('@ferretry/kernel/manifest').PluginClient = {
      async call(route, init) {
        if (route === 'GET /v1/shells/:name') return (await h.service.get('web')) as never;
        if (route === 'POST /v1/shells/preview') {
          const preview = await h.service.preview(init?.body as import('../../contract/index.ts').ShellAddRequest);
          h.nix.metadata.set('github:me/shells', flakeFacts(REV_B, HASH_B));
          if (!preview.ok) throw Error(preview.refusal.sentence);
          return preview.value as never;
        }
        if (route === 'POST /v1/shells/:name/relock') {
          const result = await h.service.relock(
            'web',
            init?.body as import('../../contract/index.ts').ShellRelockRequest,
          );
          if (!result.ok) throw Error(result.refusal.sentence);
          return result.value as never;
        }
        throw Error(route);
      },
      subscribe: () => () => {},
    };
    const half = cli.build?.({ manifest, client, io: { out() {}, err() {}, isTty: false } });
    await expect(half!.verbs['shell relock']!({ args: ['web'], options: { yes } })).rejects.toThrow(
      'changed since preview',
    );
    expect(h.tree.calls).toEqual([]);
    expect(ShellLockSchema.parse(h.state.files.get('locks/web.json')).source).toMatchObject({ narHash: HASH_A });
    const builds: readonly string[][] = [];
    h.nix.devEnv = async args => {
      (builds as string[][]).push([...args]);
      return ok({ PATH: '/p' });
    };
    await h.service.build('web');
    expect(builds[0]?.at(-1)).toBe(`${flakeFacts().url}#web`);
  });
}

test('a direct relock keeps the active lock through owner hold and activates only the exact approved hash', async () => {
  const h = shellsHarness({
    initial: { 'shells/web': { flake: 'github:me/shells#web', floating: true, approvedHash: HASH_A } },
    hold: [`the shell will execute content ${HASH_B}`],
  });
  h.nix.metadata.set('github:me/shells', flakeFacts());
  await h.service.relock('web', { expectedHash: HASH_A });
  h.published.length = 0;
  h.nix.metadata.set('github:me/shells', flakeFacts(REV_B, HASH_B));
  for (let i = 0; i < 2; i++) {
    const held = await h.service.relock('web', { expectedHash: HASH_B });
    expect(held.ok && held.value.held).toEqual([`the shell will execute content ${HASH_B}`]);
    expect(ShellLockSchema.parse(h.state.files.get('locks/web.json')).source).toMatchObject({ narHash: HASH_A });
  }
  expect(h.published).toEqual([]);
  const pending = ShellItemSchema.parse(Bun.YAML.parse(h.tree.calls.at(-1)!.text!));
  expect(pending.approvedHash).toBe(HASH_B);
  // The config port changes only when the owner confirms the held edit; a CLI request cannot set it.
  h.tree.documents.set('shells/web', pending);
  h.nix.metadata.set('github:me/shells', flakeFacts(REV_A, HASH_A));
  expect((await h.service.relock('web', { expectedHash: HASH_B })).ok).toBe(false);
  expect(ShellLockSchema.parse(h.state.files.get('locks/web.json')).source).toMatchObject({ narHash: HASH_A });
  h.nix.metadata.set('github:me/shells', flakeFacts(REV_B, HASH_B));
  expect((await h.service.relock('web', { expectedHash: HASH_B })).ok).toBe(true);
  expect(ShellLockSchema.parse(h.state.files.get('locks/web.json')).source).toMatchObject({ narHash: HASH_B });
  expect(h.tree.calls).toHaveLength(2);
});

test('a new resolution cannot become active while its approval is held for the owner', async () => {
  const hold = ['approve the resolved hash'];
  const h = shellsHarness({
    hold,
    initial: { 'shells/web': { flake: 'github:me/shells#web', floating: true } },
  });
  h.nix.metadata.set('github:me/shells', flakeFacts());
  const result = await h.service.relock('web', { expectedHash: HASH_A });
  expect(result.ok && result.value.held).toEqual(hold);
  expect(h.state.files.has('locks/web.json')).toBe(false);
  expect((await h.service.build('web')).ok).toBe(false);
});

describe('every outcome the kernel’s config writer can give', () => {
  const refused: ConfigWriteOutcome = {
    kind: 'refused',
    reason: 'schema',
    issues: [{ path: 'shells', message: 'the shell does not check' }],
  };
  const moved: ConfigWriteOutcome = { kind: 'conflict' };
  const unpinned = { 'shells/web': { flake: 'github:me/shells#web', floating: true } };

  test('add: a refusal is a 422 in the kernel’s words, a moved file a 409, and no lock is kept for either', async () => {
    const one = withWeb({ forced: refused });
    const result = await one.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    expect(!result.ok && result.refusal).toEqual({
      status: 422,
      code: SHELL_CODES.invalid,
      sentence: 'the shell does not check',
    });
    expect(one.state.files.has('locks/web.json')).toBe(false);
    expect(one.published).toEqual([]);

    const other = withWeb({ forced: moved });
    const conflict = await other.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    expect(!conflict.ok && conflict.refusal).toMatchObject({ status: 409, code: SHELL_CODES.hashChanged });
    expect(other.state.files.has('locks/web.json')).toBe(false);
    expect(other.published).toEqual([]);
  });

  test('relock: a refusal is a 422, a moved file a 409, and the active lock is kept for either', async () => {
    for (const [forced, status, code] of [
      [refused, 422, SHELL_CODES.invalid],
      [moved, 409, SHELL_CODES.hashChanged],
    ] as const) {
      const h = shellsHarness({ initial: unpinned, forced });
      h.nix.metadata.set('github:me/shells', flakeFacts());
      const result = await h.service.relock('web', { expectedHash: HASH_A });
      expect(!result.ok && result.refusal).toMatchObject({ status, code });
      expect(h.state.files.has('locks/web.json')).toBe(false);
    }
  });

  test('remove: a refusal, a moved file or a hold leaves the shell and its lock where they were', async () => {
    const seed = withWeb();
    const added = await seed.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    const lock = added.ok ? added.value.lock : undefined;
    const item = Bun.YAML.parse(seed.tree.calls[0]?.text as string);
    const held: ConfigWriteOutcome = { kind: 'held', etag: 'e1', id: 'h1', sentences: ['it waits'] };
    for (const [forced, status, code] of [
      [refused, 422, SHELL_CODES.invalid],
      [moved, 409, SHELL_CODES.hashChanged],
      [held, 409, SHELL_CODES.hashChanged],
    ] as const) {
      const h = shellsHarness({ initial: { 'shells/web': item }, forced });
      h.state.files.set('locks/web.json', lock);
      const result = await h.service.remove('web');
      expect(!result.ok && result.refusal).toMatchObject({ status, code });
      expect(h.state.files.has('locks/web.json')).toBe(true);
      expect(h.published).toEqual([]);
    }
  });
});

describe('what the service does when its stores fail it', () => {
  const lockedWeb = async () => {
    const h = withWeb();
    await h.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    return h;
  };
  const stateOf = (h: ReturnType<typeof shellsHarness>) => h.state.port as unknown as Record<string, unknown>;

  test('a lock that cannot be read is logged and treated as no lock', async () => {
    const h = await lockedWeb();
    stateOf(h).read = async () => ({ ok: false as const, error: { reason: 'disk' } });
    const parts = await h.service.launchParts('web');
    expect(parts[0]).toMatchObject({ kind: 'instruction', id: 'shell-web' });
    expect(JSON.stringify(parts)).toContain('it has not been locked');
  });

  test('a damaged cache entry is rebuilt instead of trusted', async () => {
    const h = await lockedWeb();
    await h.service.build('web');
    for (const key of h.state.files.keys()) if (key.startsWith('cache/')) h.state.files.set(key, '{not json');
    const again = await h.service.build('web');
    expect(again.ok && again.value.outcome).toBe('built');
    expect(h.nix.builds).toBe(2);
  });

  test('a cache entry kept as bytes is read, and non-string values in it are dropped', async () => {
    const h = await lockedWeb();
    await h.service.build('web');
    for (const key of h.state.files.keys())
      if (key.startsWith('cache/'))
        h.state.files.set(key, new TextEncoder().encode(JSON.stringify({ PATH: '/p', N: 1 })));
    const again = await h.service.build('web');
    expect(again.ok && again.value.outcome).toBe('cached');
    expect(h.nix.builds).toBe(1);
  });

  test('a launch that throws while preparing the shell still starts the ferret, with a word on why', async () => {
    const h = await lockedWeb();
    h.nix.facts = async () => {
      throw new Error('nix exploded');
    };
    const parts = await h.service.launchParts('web');
    expect(parts).toHaveLength(1);
    expect(JSON.stringify(parts)).toContain('it could not be prepared');
    expect(JSON.stringify(parts)).not.toContain('nix exploded');
    h.nix.facts = async () => {
      throw 'not an error object';
    };
    expect(JSON.stringify(await h.service.launchParts('web'))).toContain('it could not be prepared');
  });

  test('a relock whose approval does not show up in the effective config is refused as changed', async () => {
    const h = shellsHarness({ initial: { 'shells/web': { flake: 'github:me/shells#web', floating: true } } });
    h.nix.metadata.set('github:me/shells', flakeFacts());
    // The writer says "written" but the effective config never gains the approved hash.
    const port = h.tree.port as unknown as Record<string, unknown>;
    port.write = async () => ({ kind: 'written', etag: 'e', loosened: [] });
    const result = await h.service.relock('web', { expectedHash: HASH_A });
    expect(!result.ok && result.refusal).toMatchObject({ status: 409, code: SHELL_CODES.hashChanged });
    expect(h.state.files.has('locks/web.json')).toBe(false);
  });
});
