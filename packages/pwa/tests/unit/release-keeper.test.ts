import { describe, it } from 'bun:test';
import should from 'should';

import { parseReleaseHeaders } from '../../src/lib/release-headers.ts';
import {
  type KeeperState,
  RELEASE_CACHE_PREFIX,
  ReleaseKeeper,
  type ReleaseCaches,
  type ReleaseNetwork,
  type ReleaseResponse,
  type ReleaseStateStore,
  answerReleaseRequest,
  parseReleaseReply,
  parseReleaseRequest,
} from '../../src/lib/release-keeper.ts';
import { RELEASE_MANIFEST_FILE, RELEASE_SIGNATURE_FILE, RELEASE_WORKER_FILE } from '../../src/lib/release-manifest.ts';
import { type BuiltRelease, type ReleaseSigner, buildRelease, bytesOf, releaseSigner } from '../support/release.ts';

const ORIGIN = 'https://ferretry.example';
const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes ?? new Uint8Array());
const HEADERS = parseReleaseHeaders(
  '/*\n  Content-Security-Policy: default-src self\n/assets/*\n  Cache-Control: immutable\n',
);

/** A site whose served files a test can swap between calls. */
const site = (release: BuiltRelease | null) => {
  let served = new Map<string, Uint8Array>();
  const gets: string[] = [];
  const serve = (next: BuiltRelease | null, overrides: Record<string, string | null> = {}): void => {
    served = new Map();
    if (next !== null) {
      served.set(RELEASE_MANIFEST_FILE, next.manifestBytes);
      served.set(RELEASE_SIGNATURE_FILE, bytesOf(next.signatureText));
      for (const [path, body] of Object.entries(next.files)) served.set(path, bytesOf(body));
    }
    for (const [path, body] of Object.entries(overrides)) {
      if (body === null) served.delete(path);
      else served.set(path, bytesOf(body));
    }
  };
  serve(release);
  const network: ReleaseNetwork = {
    get: async path => {
      gets.push(path);
      return served.get(path) ?? null;
    },
  };
  return { network, serve, gets };
};

const memoryCaches = () => {
  const caches = new Map<string, Map<string, Uint8Array>>();
  const port: ReleaseCaches = {
    put: async (name, path, bytes) => {
      const cache = caches.get(name) ?? new Map();
      cache.set(path, bytes);
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

/** IndexedDB as a page sees it: anything may be written into it, at any time. */
const memoryState = (initial: unknown = null) => {
  let stored = initial;
  const port: ReleaseStateStore = {
    load: async () => stored,
    save: async state => {
      stored = state;
    },
  };
  return { port, current: () => stored as KeeperState | null, write: (value: unknown) => (stored = value) };
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
    headers: HEADERS,
  });
  return { subject, caches, state };
};

const cacheOf = (release: BuiltRelease): string =>
  `${RELEASE_CACHE_PREFIX}${release.manifest.commit}-${release.manifest.sequence}`;
const signed = (release: BuiltRelease) => ({
  manifestBytes: release.manifestBytes,
  signatureText: release.signatureText,
});

describe('ReleaseKeeper.update', () => {
  it('installs a verified release, storing the signed bytes and never a conclusion', async () => {
    // Arrange
    const signer = await releaseSigner();
    const release = await buildRelease(signer, { sequence: 4 });
    const { subject, caches, state } = keeperFor(signer, site(release).network);

    // Act
    const actual = await subject.update();

    // Assert
    should(actual).eql({ status: 'updated' });
    should(state.current()).eql({
      active: signed(release),
      previous: null,
      endorsements: [],
      lastOutcome: { status: 'updated' },
    });
    const cached = caches.caches.get(cacheOf(release));
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
    await caches.port.put(`${RELEASE_CACHE_PREFIX}orphan`, 'x', bytesOf('x'));
    await caches.port.put('somebody-else', 'x', bytesOf('x'));
    const second = await buildRelease(signer, {
      commit: 'bbbbbbb',
      sequence: 2,
      files: { ...first.files, 'assets/app-2.js': 'console.log(2)' },
    });
    served.serve(second);
    served.gets.length = 0;

    // Act
    const actual = await subject.update();

    // Assert
    should(actual).eql({ status: 'updated' });
    should(state.current()?.active).eql(signed(second));
    should(state.current()?.previous).eql(signed(first));
    should(served.gets.filter(path => path !== RELEASE_MANIFEST_FILE && path !== RELEASE_SIGNATURE_FILE)).eql([
      'assets/app-2.js',
    ]);
    should([...caches.caches.keys()].sort()).eql([cacheOf(first), cacheOf(second), 'somebody-else'].sort());
  });

  it('fetches a reusable file again when a page rewrote its cached copy, instead of refusing the release', async () => {
    // Arrange: an XSS rewrote an unchanged file in the active cache.
    const signer = await releaseSigner();
    const first = await buildRelease(signer, { commit: 'aaaaaaa' });
    const served = site(first);
    const { subject, caches } = keeperFor(signer, served.network);
    await subject.update();
    await caches.port.put(cacheOf(first), 'index.html', bytesOf('<script>backdoor()</script>'));
    const second = await buildRelease(signer, { commit: 'bbbbbbb', sequence: 2 });
    served.serve(second);
    served.gets.length = 0;

    // Act
    const actual = await subject.update();

    // Assert
    should(actual).eql({ status: 'updated' });
    should(served.gets).containEql('index.html');
    should(text(caches.caches.get(cacheOf(second))?.get('index.html'))).equal(second.files['index.html']);
  });

  it('refuses a release whose file is not the file that was signed, changing nothing it serves', async () => {
    // Arrange
    const signer = await releaseSigner();
    const first = await buildRelease(signer, { commit: 'aaaaaaa' });
    const served = site(first);
    const { subject, state } = keeperFor(signer, served.network);
    await subject.update();
    const second = await buildRelease(signer, {
      commit: 'bbbbbbb',
      sequence: 2,
      files: { ...first.files, 'assets/app-2.js': 'console.log(2)' },
    });
    served.serve(second, { 'assets/app-2.js': 'stealCredentials()' });

    // Act
    const actual = await subject.update();

    // Assert
    should(actual).eql({ status: 'refused', refusal: 'hash-mismatch', hadRelease: true });
    should(state.current()?.active).eql(signed(first));
    should(state.current()?.lastOutcome).eql(actual);
  });

  it('refuses a replayed older release by its sequence', async () => {
    // Arrange
    const signer = await releaseSigner();
    const old = await buildRelease(signer, { commit: 'aaaaaaa', sequence: 1 });
    const served = site(await buildRelease(signer, { commit: 'bbbbbbb', sequence: 2 }));
    const { subject } = keeperFor(signer, served.network);
    await subject.update();
    served.serve(old);

    // Act
    const actual = await subject.update();

    // Assert
    should(actual).eql({ status: 'refused', refusal: 'older', hadRelease: true });
  });

  it('refuses a release signed by someone else and says there was nothing installed yet', async () => {
    // Arrange
    const compiled = await releaseSigner();
    const stranger = await releaseSigner();
    const { subject, state } = keeperFor(compiled, site(await buildRelease(stranger)).network);

    // Act
    const actual = await subject.update();

    // Assert
    should(actual).eql({ status: 'refused', refusal: 'unknown-key', hadRelease: false });
    should(state.current()?.active).be.null();
  });

  it('trusts nothing a page wrote into the record: a forged release, a forged key, a forged outcome', async () => {
    // Arrange: an XSS installs its own release, endorses its own key and hides a refusal.
    const compiled = await releaseSigner();
    const attacker = await releaseSigner();
    const forged = await buildRelease(attacker, { sequence: 99, nextKey: attacker.publicKey });
    const state = memoryState({
      active: signed(forged),
      previous: signed(forged),
      endorsements: [signed(forged), 'junk'],
      lastOutcome: { status: 'refused', refusal: 'made-up', hadRelease: true },
      trust: { keys: [attacker.publicKey] },
    });
    const served = site(forged);
    const { subject } = keeperFor(compiled, served.network, { state });

    // Act
    const answer = await subject.respond({ pathname: '/', navigate: true });
    const outcome = await subject.lastOutcome();
    const checked = await subject.update();

    // Assert
    should(answer).be.null();
    should(outcome).be.null();
    should(checked).eql({ status: 'refused', refusal: 'unknown-key', hadRelease: false });
    should(state.current()).eql({ active: null, previous: null, endorsements: [], lastOutcome: checked });
  });

  it.each([
    ['nothing', null],
    ['a string', 'junk'],
    ['records of the wrong shape', { active: { manifestBytes: 'x', signatureText: 1 }, endorsements: 'x' }],
  ])('reads %s in the record as no release', async (_name, stored) => {
    const signer = await releaseSigner();
    const { subject } = keeperFor(signer, site(null).network, { state: memoryState(stored) });
    should(await subject.respond({ pathname: '/assets/app-1.js', navigate: false })).be.null();
    should(await subject.lastOutcome()).be.null();
  });

  it('follows a planned rotation: the announced key signs, and the old key is then refused', async () => {
    // Arrange
    const old = await releaseSigner();
    const next = await releaseSigner();
    const announcing = await buildRelease(old, { commit: 'aaaaaaa', sequence: 1, nextKey: next.publicKey });
    const served = site(announcing);
    const { subject, state } = keeperFor(old, served.network);
    await subject.update();
    served.serve(await buildRelease(next, { commit: 'bbbbbbb', sequence: 2 }));

    // Act
    const rotated = await subject.update();
    served.serve(await buildRelease(old, { commit: 'ccccccc', sequence: 3 }));
    const retired = await subject.update();

    // Assert
    should(rotated).eql({ status: 'updated' });
    should(state.current()?.endorsements).eql([signed(announcing)]);
    should(retired).eql({ status: 'refused', refusal: 'unknown-key', hadRelease: true });
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

  it('keeps answering correctly once it has checked more signatures than it remembers', async () => {
    // Arrange
    const signer = await releaseSigner();
    const served = site(null);
    const { subject } = keeperFor(signer, served.network);

    // Act: every update checks a new list, so the remembered checks overflow and are dropped.
    for (let sequence = 1; sequence <= 40; sequence += 1) {
      served.serve(await buildRelease(signer, { sequence, files: { [RELEASE_WORKER_FILE]: `w${sequence}` } }));
      await subject.update();
    }

    // Assert
    should(await subject.update()).eql({ status: 'current' });
  });
});

describe('what a page writes back', () => {
  it('does not serve an older release a page put back after this worker installed a newer one', async () => {
    // Arrange: release 1 is replaced by 2, then a page writes 1 back as active.
    const signer = await releaseSigner();
    const first = await buildRelease(signer, { commit: 'aaaaaaa', sequence: 1 });
    const served = site(first);
    const { subject, state } = keeperFor(signer, served.network);
    await subject.update();
    served.serve(await buildRelease(signer, { commit: 'bbbbbbb', sequence: 2 }));
    await subject.update();
    state.write({ ...state.current(), active: signed(first) });

    // Act
    const answer = await subject.respond({ pathname: '/', navigate: true });
    const checked = await subject.update();

    // Assert: nothing served from release 1, and the next check puts release 2 back.
    should(answer).be.null();
    should(checked).eql({ status: 'updated' });
  });

  it('does not take a remembered signature as proof for different bytes', async () => {
    // Arrange: the genuine list was checked (and remembered); a page pairs its signature with other bytes.
    const signer = await releaseSigner();
    const release = await buildRelease(signer);
    const { subject, state } = keeperFor(signer, site(release).network);
    await subject.update();
    const forged = bytesOf(text(release.manifestBytes).replace('1.0.0', '9.9.9'));
    state.write({ ...state.current(), active: { manifestBytes: forged, signatureText: release.signatureText } });

    // Act
    const actual = await subject.respond({ pathname: '/', navigate: true });

    // Assert
    should(actual).be.null();
  });
});

describe('ReleaseKeeper.respond', () => {
  const installed = async () => {
    const signer = await releaseSigner();
    const first = await buildRelease(signer, {
      commit: 'aaaaaaa',
      files: { [RELEASE_WORKER_FILE]: 'w', 'assets/old.js': 'old', 'old.html': 'old page' },
    });
    const served = site(first);
    const kept = keeperFor(signer, served.network);
    await kept.subject.update();
    const second = await buildRelease(signer, {
      commit: 'bbbbbbb',
      sequence: 2,
      files: { [RELEASE_WORKER_FILE]: 'w', 'index.html': 'shell', 'app/index.html': 'app', 'assets/new.js': 'new' },
    });
    served.serve(second);
    await kept.subject.update();
    return { ...kept, served, second };
  };

  const body = (answer: ReleaseResponse | null): string | null => (answer === null ? null : text(answer.bytes));

  it.each([
    ['a file of the active release', { pathname: '/assets/new.js', navigate: false }, 'new'],
    ['an app route, through the rewrites', { pathname: '/app/settings', navigate: true }, 'app'],
    ['a page load the release does not list, with its shell', { pathname: '/evil.html', navigate: true }, 'shell'],
    [
      'a page load of the signed list, with its shell',
      { pathname: `/${RELEASE_MANIFEST_FILE}`, navigate: true },
      'shell',
    ],
    [
      'a page load of the signature, with its shell',
      { pathname: `/${RELEASE_SIGNATURE_FILE}`, navigate: true },
      'shell',
    ],
    [
      'a page only the previous release had, with the current shell',
      { pathname: '/old.html', navigate: true },
      'shell',
    ],
    [
      'a chunk only the previous release had, for a page still running it',
      { pathname: '/assets/old.js', navigate: false },
      'old',
    ],
  ])('answers %s from verified bytes', async (_name, request, expected) => {
    const { subject } = await installed();
    should(body(await subject.respond(request))).equal(expected);
  });

  it.each([
    ['the worker script', `/${RELEASE_WORKER_FILE}`],
    ['the signed list', `/${RELEASE_MANIFEST_FILE}`],
    ['the signature', `/${RELEASE_SIGNATURE_FILE}`],
    ['a file no release lists', '/assets/unknown.js'],
    ['a non-chunk only the previous release had', '/old.html'],
  ])('leaves a fetch of %s to the network', async (_name, pathname) => {
    const { subject } = await installed();
    should(await subject.respond({ pathname, navigate: false })).be.null();
  });

  it('serves the headers _headers names for the REQUESTED path, never stored ones', async () => {
    const { subject } = await installed();
    const answer = await subject.respond({ pathname: '/assets/new.js', navigate: false });
    should(answer?.status).equal(200);
    should(answer?.headers).eql([
      ['Content-Security-Policy', 'default-src self'],
      ['Cache-Control', 'immutable'],
      ['Content-Type', 'text/javascript; charset=utf-8'],
    ]);
  });

  it('never serves a cached copy a page rewrote: it fetches the signed file again and repairs the cache', async () => {
    // Arrange
    const { subject, caches, second } = await installed();
    await caches.port.put(cacheOf(second), 'app/index.html', bytesOf('<script>backdoor()</script>'));

    // Act
    const actual = await subject.respond({ pathname: '/app/', navigate: true });

    // Assert
    should(body(actual)).equal('app');
    should(text(caches.caches.get(cacheOf(second))?.get('app/index.html'))).equal('app');
  });

  it('refuses to load a file when neither the cache nor the site has the signed bytes', async () => {
    // Arrange
    const { subject, caches, served, second } = await installed();
    caches.caches.delete(cacheOf(second));
    served.serve(second, { 'assets/new.js': 'tampered()' });

    // Act
    const actual = await subject.respond({ pathname: '/assets/new.js', navigate: false });

    // Assert
    should(actual?.status).equal(503);
    should(body(actual)).match(/could not be checked/u);
    should(actual?.headers).containEql(['Content-Type', 'text/plain; charset=utf-8']);
  });

  it('answers a page load with a refusal when the release has no shell to fall back to', async () => {
    // Arrange
    const signer = await releaseSigner();
    const { subject } = keeperFor(
      signer,
      site(await buildRelease(signer, { files: { [RELEASE_WORKER_FILE]: 'w' } })).network,
    );
    await subject.update();

    // Act
    const actual = await subject.respond({ pathname: '/anything', navigate: true });

    // Assert
    should(actual?.status).equal(503);
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
    await subject.update();

    // Act
    const actual = await subject.isSignedWorker(path, bytesOf(script));

    // Assert
    should(actual).equal(expected);
  });

  it('accepts the worker of a newer signed release the site serves, without installing that release', async () => {
    // Arrange
    const signer = await releaseSigner();
    const served = site(await buildRelease(signer));
    const { subject, state } = keeperFor(signer, served.network);
    await subject.update();
    const before = state.current();
    served.serve(await buildRelease(signer, { sequence: 2, files: { [RELEASE_WORKER_FILE]: 'the new worker' } }));
    served.gets.length = 0;

    // Act
    const actual = await subject.isSignedWorker(RELEASE_WORKER_FILE, bytesOf('the new worker'));

    // Assert
    should(actual).be.true();
    should(served.gets.sort()).eql([RELEASE_MANIFEST_FILE, RELEASE_SIGNATURE_FILE]);
    should(state.current()).equal(before);
  });

  it.each([
    ['the site serves no list', null],
    ['the site serves a list somebody else signed', 'stranger'],
  ] as const)('answers no when %s', async (_name, servedBy) => {
    const signer = await releaseSigner();
    const release =
      servedBy === null ? null : await buildRelease(await releaseSigner(), { files: { [RELEASE_WORKER_FILE]: 'x' } });
    should(
      await keeperFor(signer, site(release).network).subject.isSignedWorker(RELEASE_WORKER_FILE, bytesOf('x')),
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
      { type: 'fy-release-outcome', outcome: { status: 'refused', refusal: 'older', hadRelease: true } },
      { type: 'fy-release-outcome', outcome: { status: 'refused', refusal: 'older', hadRelease: true } },
    ],
    [
      { type: 'fy-release-outcome', outcome: null },
      { type: 'fy-release-outcome', outcome: null },
    ],
    [{ type: 'fy-release-outcome', outcome: { status: 'refused', refusal: 'made-up', hadRelease: true } }, null],
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
