import { describe, it } from 'bun:test';
import should from 'should';

import {
  type KeeperState,
  RELEASE_CACHE_PREFIX,
  ReleaseKeeper,
  type ReleaseCaches,
  type ReleaseFile,
  type ReleaseNetwork,
  type ReleaseStateStore,
  answerReleaseRequest,
  parseReleaseReply,
  parseReleaseRequest,
} from '../../src/lib/release-keeper.ts';
import { RELEASE_MANIFEST_FILE, RELEASE_SIGNATURE_FILE, RELEASE_WORKER_FILE } from '../../src/lib/release-manifest.ts';
import { type BuiltRelease, type ReleaseSigner, buildRelease, bytesOf, releaseSigner } from '../support/release.ts';

const ORIGIN = 'https://ferretry.example';

/** A site whose served files a test can swap between calls. */
const site = (release: BuiltRelease | null) => {
  let served = new Map<string, Uint8Array>();
  const gets: string[] = [];
  const serve = (next: BuiltRelease | null, overrides: Record<string, string | null> = {}): void => {
    served = new Map();
    if (next !== null) {
      served.set(RELEASE_MANIFEST_FILE, next.manifestBytes);
      served.set(RELEASE_SIGNATURE_FILE, bytesOf(next.signatureText));
      for (const [path, text] of Object.entries(next.files)) served.set(path, bytesOf(text));
    }
    for (const [path, text] of Object.entries(overrides)) {
      if (text === null) served.delete(path);
      else served.set(path, bytesOf(text));
    }
  };
  serve(release);
  const network: ReleaseNetwork = {
    get: async path => {
      gets.push(path);
      const bytes = served.get(path);
      return bytes === undefined ? null : { bytes, headers: [['content-type', 'text/plain']] };
    },
  };
  return { network, serve, gets };
};

const memoryCaches = () => {
  const caches = new Map<string, Map<string, ReleaseFile>>();
  const port: ReleaseCaches = {
    put: async (name, path, file) => {
      const cache = caches.get(name) ?? new Map();
      cache.set(path, file);
      caches.set(name, cache);
    },
    get: async (name, path) => caches.get(name)?.get(path) ?? null,
    names: async () => [...caches.keys()],
    remove: async name => {
      caches.delete(name);
    },
  };
  return { port, caches };
};

const memoryState = (initial: KeeperState | null = null) => {
  let stored = initial;
  const saves: KeeperState[] = [];
  const port: ReleaseStateStore = {
    load: async () => stored,
    save: async state => {
      saves.push(state);
      stored = state;
    },
  };
  return { port, saves, current: () => stored };
};

const keeperFor = (
  signer: ReleaseSigner,
  network: ReleaseNetwork,
  options: {
    caches?: ReturnType<typeof memoryCaches>;
    state?: ReturnType<typeof memoryState>;
    allowUnsigned?: boolean;
  } = {},
) => {
  const caches = options.caches ?? memoryCaches();
  const state = options.state ?? memoryState();
  const subject = new ReleaseKeeper({
    network,
    caches: caches.port,
    state: state.port,
    compiledKey: signer.publicKey,
    allowUnsigned: options.allowUnsigned ?? false,
    rewrites: [{ from: '/app/*', to: '/app/index.html' }],
  });
  return { subject, caches, state };
};

describe('ReleaseKeeper.update', () => {
  it('installs a verified release on first use, pinning the compiled-in key', async () => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer);
    const { subject, caches, state } = keeperFor(signer, site(release).network);

    // Act
    const actual = await subject.update();

    // Assert
    should(actual).eql({ status: 'updated' });
    const stored = state.current();
    should(stored?.trust.keys).eql([signer.publicKey]);
    should(stored?.active?.manifest).eql(release.manifest);
    should(stored?.previous).be.null();
    const cached = caches.caches.get(stored?.active?.cacheName ?? '');
    should([...(cached?.keys() ?? [])].sort()).eql(Object.keys(release.files).sort());
  });

  it('answers current, and fetches no file, when the served release is the installed one', async () => {
    // Arrange
    const signer = await releaseSigner();
    const served = site(await buildRelease(signer));
    const { subject } = keeperFor(signer, served.network);
    await subject.update();
    served.gets.length = 0;

    // Act
    const actual = await subject.update();

    // Assert
    should(actual).eql({ status: 'current' });
    should(served.gets.sort()).eql([RELEASE_MANIFEST_FILE, RELEASE_SIGNATURE_FILE]);
  });

  it('moves to a newer release, keeps the old one as previous, reuses unchanged files and prunes the rest', async () => {
    // Arrange
    const signer = await releaseSigner();
    const first = await buildRelease(signer, { commit: 'aaaaaaa' });
    const served = site(first);
    const { subject, caches, state } = keeperFor(signer, served.network);
    await subject.update();
    const firstCache = state.current()?.active?.cacheName;
    await caches.port.put(`${RELEASE_CACHE_PREFIX}orphan`, 'x', { bytes: bytesOf('x'), headers: [] });
    await caches.port.put('somebody-else', 'x', { bytes: bytesOf('x'), headers: [] });
    const second = await buildRelease(signer, {
      commit: 'bbbbbbb',
      version: '1.0.1',
      files: { ...first.files, 'assets/app-2.js': 'console.log(2)' },
    });
    served.serve(second);
    served.gets.length = 0;

    // Act
    const actual = await subject.update();

    // Assert
    should(actual).eql({ status: 'updated' });
    should(state.current()?.previous?.cacheName).equal(firstCache);
    should(served.gets.filter(path => path !== RELEASE_MANIFEST_FILE && path !== RELEASE_SIGNATURE_FILE)).eql([
      'assets/app-2.js',
    ]);
    should([...caches.caches.keys()].sort()).eql(
      [firstCache, state.current()?.active?.cacheName, 'somebody-else'].sort(),
    );
  });

  it('refuses a release whose file is not the file that was signed, changing nothing it serves', async () => {
    // Arrange
    const signer = await releaseSigner();
    const first = await buildRelease(signer, { commit: 'aaaaaaa' });
    const served = site(first);
    const { subject, state } = keeperFor(signer, served.network);
    await subject.update();
    const before = state.current()?.active;
    const second = await buildRelease(signer, {
      commit: 'bbbbbbb',
      version: '2.0.0',
      files: { ...first.files, 'assets/app-2.js': 'console.log(2)' },
    });
    served.serve(second, { 'assets/app-2.js': 'stealCredentials()' });

    // Act
    const actual = await subject.update();

    // Assert
    should(actual).eql({ status: 'refused', refusal: 'hash-mismatch', hadRelease: true });
    should(state.current()?.active).eql(before);
    should(state.current()?.lastOutcome).eql(actual);
  });

  it('refuses a release signed by someone else and says there was nothing installed yet', async () => {
    // Arrange
    const pinned = await releaseSigner();
    const stranger = await releaseSigner();
    const { subject, state } = keeperFor(pinned, site(await buildRelease(stranger)).network);

    // Act
    const actual = await subject.update();

    // Assert
    should(actual).eql({ status: 'refused', refusal: 'unknown-key', hadRelease: false });
    should(state.current()?.active).be.null();
  });

  it('keeps the PINNED key even when a later worker carries a different compiled-in key', async () => {
    // Arrange
    const pinned = await releaseSigner();
    const attacker = await releaseSigner();
    const state = memoryState();
    await keeperFor(pinned, site(await buildRelease(pinned)).network, { state }).subject.update();
    const replaced = keeperFor(attacker, site(await buildRelease(attacker, { version: '9.0.0' })).network, { state });

    // Act
    const actual = await replaced.subject.update();

    // Assert
    should(actual).eql({ status: 'refused', refusal: 'unknown-key', hadRelease: true });
    should(state.current()?.trust.keys).eql([pinned.publicKey]);
  });

  it('answers unreachable when the list, the signature or a file cannot be fetched', async () => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer);
    const noSignature = site(release);
    noSignature.serve(release, { [RELEASE_SIGNATURE_FILE]: null });
    const noFile = site(release);
    noFile.serve(release, { 'assets/app-1.js': null });

    // Act
    const missingSignature = await keeperFor(signer, noSignature.network).subject.update();
    const missingFile = await keeperFor(signer, noFile.network).subject.update();

    // Assert
    should(missingSignature).eql({ status: 'unreachable' });
    should(missingFile).eql({ status: 'unreachable' });
  });

  it('answers unverified for an unsigned dev build, caching nothing', async () => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer);
    const served = site(release);
    served.serve(release, { [RELEASE_SIGNATURE_FILE]: 'unsigned' });
    const { subject, caches } = keeperFor(signer, served.network, { allowUnsigned: true });

    // Act
    const actual = await subject.update();

    // Assert
    should(actual).eql({ status: 'unverified' });
    should(caches.caches.size).equal(0);
  });

  it('runs one check at a time and tells every caller its answer', async () => {
    // Arrange
    const signer = await releaseSigner();
    const served = site(await buildRelease(signer));
    const { subject } = keeperFor(signer, served.network);

    // Act
    const [first, second] = await Promise.all([subject.update(), subject.update()]);

    // Assert
    should(first).eql({ status: 'updated' });
    should(second).equal(first);
    should(served.gets.filter(path => path === RELEASE_MANIFEST_FILE)).have.length(1);
  });

  it('ignores a stored release whose list no longer parses', async () => {
    // Arrange
    const signer = await releaseSigner();
    const broken = { cacheName: 'x', manifest: { version: 'nope' } } as unknown as KeeperState['active'];
    const state = memoryState({
      trust: { keys: [signer.publicKey], installed: null },
      active: broken,
      previous: broken,
      lastOutcome: null,
    });
    const { subject } = keeperFor(signer, site(null).network, { state });

    // Act
    const actual = await subject.respond({ pathname: '/assets/app-1.js', navigate: false });

    // Assert
    should(actual).be.null();
  });
});

describe('ReleaseKeeper.respond', () => {
  const installed = async () => {
    const signer = await releaseSigner();
    const first = await buildRelease(signer, {
      commit: 'aaaaaaa',
      files: { [RELEASE_WORKER_FILE]: 'w', 'assets/old.js': 'old' },
    });
    const served = site(first);
    const kept = keeperFor(signer, served.network);
    await kept.subject.update();
    served.serve(
      await buildRelease(signer, {
        commit: 'bbbbbbb',
        version: '1.0.1',
        files: { [RELEASE_WORKER_FILE]: 'w', 'app/index.html': 'app', 'assets/new.js': 'new' },
      }),
    );
    await kept.subject.update();
    return kept.subject;
  };

  it.each([
    ['a file of the active release', { pathname: '/assets/new.js', navigate: false }, 'new'],
    ['an app route, through the rewrites', { pathname: '/app/settings', navigate: true }, 'app'],
    [
      'a file only the previous release had, for a page still running it',
      { pathname: '/assets/old.js', navigate: false },
      'old',
    ],
  ])('answers %s from verified bytes', async (_name, request, expected) => {
    const subject = await installed();
    should(new TextDecoder().decode((await subject.respond(request))?.bytes)).equal(expected);
  });

  it.each([
    ['the worker script', `/${RELEASE_WORKER_FILE}`],
    ['the signed list', `/${RELEASE_MANIFEST_FILE}`],
    ['the signature', `/${RELEASE_SIGNATURE_FILE}`],
    ['a file no release lists', '/assets/unknown.js'],
  ])('leaves %s to the network', async (_name, pathname) => {
    const subject = await installed();
    should(await subject.respond({ pathname, navigate: false })).be.null();
  });

  it('answers nothing before any release was installed', async () => {
    const signer = await releaseSigner();
    should(await keeperFor(signer, site(null).network).subject.respond({ pathname: '/', navigate: true })).be.null();
  });
});

describe('ReleaseKeeper.isSignedWorker', () => {
  it.each([
    ['the listed worker at its own path', RELEASE_WORKER_FILE, 'self.addEventListener("fetch", () => {})', true],
    ['the listed worker with other bytes', RELEASE_WORKER_FILE, 'evil()', false],
    ['another path with the listed bytes', 'sw.other.js', 'self.addEventListener("fetch", () => {})', false],
  ])('answers %s', async (_name, path, script, expected) => {
    // Arrange
    const signer = await releaseSigner();
    const { subject } = keeperFor(signer, site(await buildRelease(signer)).network);

    // Act
    const actual = await subject.isSignedWorker(path, bytesOf(script));

    // Assert
    should(actual).equal(expected);
  });

  it('answers no when no release could be installed', async () => {
    const signer = await releaseSigner();
    should(
      await keeperFor(signer, site(null).network).subject.isSignedWorker(RELEASE_WORKER_FILE, bytesOf('x')),
    ).be.false();
  });
});

describe('the page ↔ worker messages', () => {
  it.each([
    [{ type: 'fy-release-status' }, { type: 'fy-release-status' }],
    [{ type: 'fy-release-check', extra: 1 }, { type: 'fy-release-check' }],
    [
      { type: 'fy-release-audit-worker', scriptUrl: '/sw.js' },
      { type: 'fy-release-audit-worker', scriptUrl: '/sw.js' },
    ],
    [{ type: 'fy-release-audit-worker' }, null],
    [{ type: 'SKIP_WAITING' }, null],
    ['fy-release-check', null],
    [null, null],
  ])('parses the request %j', (input, expected) => {
    should(parseReleaseRequest(input)).eql(expected);
  });

  it.each([
    [
      { type: 'fy-release-outcome', outcome: { status: 'current' } },
      { type: 'fy-release-outcome', outcome: { status: 'current' } },
    ],
    [
      { type: 'fy-release-outcome', outcome: null },
      { type: 'fy-release-outcome', outcome: null },
    ],
    [{ type: 'fy-release-outcome', outcome: { status: 1 } }, null],
    [{ type: 'fy-release-outcome' }, null],
    [
      { type: 'fy-release-worker-audit', signed: true },
      { type: 'fy-release-worker-audit', signed: true },
    ],
    [{ type: 'fy-release-worker-audit', signed: 'yes' }, null],
    [{ type: 'other' }, null],
    [7, null],
  ])('parses the reply %j', (input, expected) => {
    should(parseReleaseReply(input)).eql(expected);
  });

  const answering = async () => {
    const signer = await releaseSigner();
    const served = site(await buildRelease(signer));
    const { subject } = keeperFor(signer, served.network);
    return { subject, network: served.network };
  };

  it('answers status with the last outcome and check with a fresh one', async () => {
    // Arrange
    const { subject, network } = await answering();

    // Act
    const before = await answerReleaseRequest(subject, { type: 'fy-release-status' }, ORIGIN, network);
    const checked = await answerReleaseRequest(subject, { type: 'fy-release-check' }, ORIGIN, network);
    const after = await answerReleaseRequest(subject, { type: 'fy-release-status' }, ORIGIN, network);

    // Assert
    should(before).eql({ type: 'fy-release-outcome', outcome: null });
    should(checked).eql({ type: 'fy-release-outcome', outcome: { status: 'updated' } });
    should(after).eql({ type: 'fy-release-outcome', outcome: { status: 'updated' } });
  });

  it.each([
    ['the signed worker on this origin', `${ORIGIN}/${RELEASE_WORKER_FILE}`, true],
    ['a worker on another origin, never fetched', `https://evil.example/${RELEASE_WORKER_FILE}`, false],
    ['a URL that does not parse', 'not a url', false],
    ['a worker this origin does not serve', `${ORIGIN}/sw.missing.js`, false],
  ])('audits %s', async (_name, scriptUrl, expected) => {
    // Arrange
    const { subject, network } = await answering();

    // Act
    const actual = await answerReleaseRequest(subject, { type: 'fy-release-audit-worker', scriptUrl }, ORIGIN, network);

    // Assert
    should(actual).eql({ type: 'fy-release-worker-audit', signed: expected });
  });
});
