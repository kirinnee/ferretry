import { describe, expect, test } from 'bun:test';
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

  test('a shell that is new is held for the owner: the lock is kept and the sentences come back', async () => {
    const h = withWeb({ hold: ['a new shell will build x'] });
    const result = await h.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    expect(result.ok && result.value.held).toEqual(['a new shell will build x']);
    expect(result.ok && result.value.lock.name).toBe('web');
  });

  test('a name already taken is a conflict; no nix is a conflict that says what to do; no door is 503', async () => {
    const taken = withWeb({ initial: { 'shells/web': { flake: lockedRef } } });
    expect((await taken.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) })).ok).toBe(false);
    const result = await taken.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    expect(!result.ok && result.refusal.code).toBe(SHELL_CODES.exists);

    const noNix = withWeb();
    noNix.nix.facts_ = { present: false, consequence: 'ferrets use the machine’s tools', remedy: 'install nix' };
    const refused = await noNix.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    expect(!refused.ok && refused.refusal).toMatchObject({ status: 409, code: SHELL_CODES.noNix });
    expect(!refused.ok && refused.refusal.sentence).toContain('install nix');

    const noDoor = withWeb({ noDoor: true });
    const unavailable = await noDoor.service.add({ name: 'web', item: ShellItemSchema.parse(webItem) });
    expect(!unavailable.ok && unavailable.refusal).toMatchObject({ status: 503, code: SHELL_CODES.noConfigDoor });
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
    const result = await h.service.relock('web');
    expect(!result.ok && result.refusal).toMatchObject({ status: 409, code: SHELL_CODES.hashChanged });
    const lock = h.state.files.get('locks/web.json') as { source: { narHash: string } };
    expect(lock.source.narHash).toBe(HASH_A);
  });

  test('a floating shell takes the new hash on relock and says what it changed from', async () => {
    const h = shellsHarness({ initial: { 'shells/web': { flake: 'github:me/shells#web', floating: true } } });
    h.nix.metadata.set('github:me/shells', flakeFacts(REV_A, HASH_A));
    await h.service.relock('web');
    h.nix.metadata.set('github:me/shells', flakeFacts(REV_B, HASH_B));
    const result = await h.service.relock('web');
    expect(result.ok && result.value.changedFrom).toBe(HASH_A);
    expect((h.state.files.get('locks/web.json') as { source: { narHash: string } }).source.narHash).toBe(HASH_B);
  });

  test('an unknown shell is 404', async () => {
    const result = await shellsHarness().service.relock('nope');
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
