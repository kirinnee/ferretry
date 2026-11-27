import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fromBase64UrlFixed, X25519_PUBLIC_KEY_BYTES } from '@ferretry/std/sealing';
import {
  type BundleEntryKind,
  type BundleHeader,
  RELOCATE_MAX_BUNDLE_BYTES,
  RELOCATE_MAX_FILE_BYTES,
} from '../../contract/index.ts';
import { kernelCheckout } from '../../daemon/lib/checkout.ts';
import { toHex } from '../../daemon/lib/hex.ts';
import { RelocateRefused } from '../../daemon/lib/relocation.ts';
import { normalizeRemote } from '../../daemon/lib/remote.ts';
import { sealBundle } from '../../daemon/lib/seal.ts';
import { CONVERSATION } from '../support/fake-ferrets.ts';
import { bundleSigner, crypto, newIdentity } from '../support/identity.ts';
import { git, makeRepository, REMOTE_URL } from '../support/real-git.ts';
import { type TargetOptions, targetWorld } from '../support/target.ts';

/**
 * Bundles made BY HAND, so each refusal the target has can be asked for on its own: the real sealing, the real offer book,
 * the real importer and real git, and a bundle that is wrong in exactly one way. Every refusal must leave the target as it was.
 */

interface Entry {
  readonly kind: BundleEntryKind;
  readonly path: string;
  readonly bytes: Uint8Array;
  /** Lies the manifest tells about this entry. */
  readonly size?: number;
  readonly sha256?: string;
}

interface Spec {
  readonly record?: string;
  readonly recordHarness?: string;
  /** `null`: the bundle carries no working tree at all. */
  readonly worktree?: { readonly head: string; readonly branch?: string } | null;
  readonly runtime?: string;
  readonly extra?: readonly Entry[];
  readonly sourceDaemonId?: string;
  readonly chunkBytes?: number;
  /** The whole plain bundle, in place of the manifest and entries. */
  readonly parts?: readonly Uint8Array[];
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const NO_HEAD = 'a'.repeat(40);

const refusal = async (work: Promise<unknown>): Promise<RelocateRefused> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof RelocateRefused) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

async function fixtureWorld(options: TargetOptions = {}) {
  const fixture = makeRepository();
  const target = await targetWorld(options, fixture.remote);
  // the first commit is on the remote, and so in the target's clone: a moved ferret may stand on it without any commits
  const pushed = git(fixture.folder, 'rev-parse', 'HEAD~1').trim();
  return { fixture, target, pushed };
}

/** Opens an offer on the target, seals `spec` to it, and uploads `upload` chunks (all of them by default). */
async function craft(target: Awaited<ReturnType<typeof targetWorld>>, spec: Spec, upload?: number) {
  const offer = await target.offers.open();
  const offerKey = fromBase64UrlFixed(offer.publicKey, X25519_PUBLIC_KEY_BYTES);
  if (offerKey === null) throw new Error('the offer carries no key');
  const entries: Entry[] = [
    {
      kind: 'ferret-record',
      path: 'record.json',
      bytes: text(spec.record ?? JSON.stringify({ name: 'Mover', harness: spec.recordHarness ?? 'claude-code' })),
    },
    { kind: 'conversation', path: CONVERSATION.relPath, bytes: text(CONVERSATION.text) },
    ...(spec.extra ?? []),
  ];
  const manifest = {
    v: 1,
    ferret: { id: 'f-move-1', name: 'Mover' },
    needs: {
      harness: 'claude-code',
      ...(spec.runtime === undefined ? {} : { runtime: spec.runtime }),
      remote: normalizeRemote(REMOTE_URL),
      secrets: [],
    },
    ...(spec.worktree === null ? {} : { worktree: spec.worktree ?? { head: NO_HEAD } }),
    entries: await Promise.all(
      entries.map(async entry => ({
        kind: entry.kind,
        path: entry.path,
        size: entry.size ?? entry.bytes.length,
        sha256: entry.sha256 ?? toHex(await crypto.sha256(entry.bytes)),
      })),
    ),
  };
  const manifestBytes = text(JSON.stringify(manifest));
  const framed = new Uint8Array(4 + manifestBytes.length);
  new DataView(framed.buffer).setUint32(0, manifestBytes.length, false);
  framed.set(manifestBytes, 4);
  const identity = await newIdentity();
  const sourceDaemonId = spec.sourceDaemonId ?? identity.daemonId;
  const sealed = await sealBundle(crypto, {
    offer,
    offerKey,
    signer: bundleSigner({ ...identity, daemonId: sourceDaemonId }),
    sourceDaemonId,
    parts: spec.parts ?? [framed, ...entries.map(entry => entry.bytes)],
    chunkBytes: spec.chunkBytes ?? 1024 * 1024,
  });
  for (const [index, chunk] of sealed.chunks.entries()) {
    if (upload !== undefined && index >= upload) break;
    target.importer.receive(offer.offerId, index, chunk);
  }
  return { offerId: offer.offerId, header: sealed.header, offer };
}

/** The target must be exactly as it was after a refusal. */
async function refused(
  spec: Spec,
  options: TargetOptions = {},
  upload?: number,
  tweak?: (h: BundleHeader) => BundleHeader,
) {
  const { target } = await fixtureWorld(options);
  const before = target.shape();
  const made = await craft(target, spec, upload);
  const error = await refusal(
    target.importer.import(made.offerId, {
      header: tweak?.(made.header) ?? made.header,
      sourceDaemonId: made.header.sourceDaemonId,
    }),
  );
  expect(target.started).toEqual([]);
  expect(target.shape()).toEqual(before);
  return error;
}

describe('a bundle that cannot be trusted is refused, and nothing is written', () => {
  test('a header sealed for another offer', async () => {
    const error = await refused({}, {}, undefined, header => ({ ...header, offerId: 'fy_relocate_offer_other' }));
    expect(error).toMatchObject({ status: 400, code: 'bundle_refused' });
    expect(error.message).toContain('another offer');
  });

  test('a ferret sent by this very machine', async () => {
    const { target } = await fixtureWorld();
    const before = target.shape();
    const made = await craft(target, { sourceDaemonId: target.daemonId });
    const error = await refusal(
      target.importer.import(made.offerId, { header: made.header, sourceDaemonId: made.header.sourceDaemonId }),
    );
    expect(error.message).toContain('from itself');
    expect(target.shape()).toEqual(before);
  });

  test('a header that says it is larger than a move can be', async () => {
    const error = await refused({}, {}, undefined, header => ({
      ...header,
      bytes: RELOCATE_MAX_BUNDLE_BYTES + 1_000_000,
    }));
    expect(error.message).toContain('larger than a move can be');
  });

  test('chunks that did not all arrive', async () => {
    const error = await refused({ chunkBytes: 64 }, {}, 1);
    expect(error.message).toMatch(/1 of \d+ chunks arrived/u);
  });

  test('a manifest of no length', async () => {
    const error = await refused({ parts: [new Uint8Array(16)] });
    expect(error.message).toContain('is not a manifest');
  });

  test('a manifest that is not JSON', async () => {
    const framed = new Uint8Array(4 + 5);
    new DataView(framed.buffer).setUint32(0, 5, false);
    framed.set(text('xxxxx'), 4);
    const error = await refused({ parts: [framed] });
    expect(error.message).toContain('is not a manifest');
  });

  test('a file that would land outside the working tree', async () => {
    const error = await refused({
      worktree: { head: NO_HEAD },
      extra: [{ kind: 'worktree-file', path: '../escape.txt', bytes: text('x') }],
    });
    expect(error.message).toContain('does not belong to a move');
  });

  test('a file the manifest says is larger than a move allows', async () => {
    const error = await refused({
      worktree: { head: NO_HEAD },
      extra: [{ kind: 'worktree-file', path: 'big.bin', bytes: text('x'), size: RELOCATE_MAX_FILE_BYTES + 1 }],
    });
    expect(error.message).toContain('larger than a move allows');
  });

  test('a file whose bytes are not the ones the manifest hashed', async () => {
    const error = await refused({
      worktree: { head: NO_HEAD },
      extra: [{ kind: 'worktree-file', path: 'a.txt', bytes: text('x'), sha256: 'f'.repeat(64) }],
    });
    expect(error.message).toContain('does not match its hash');
  });

  test('working-tree files in a bundle that has no working tree', async () => {
    const error = await refused({
      worktree: null,
      extra: [{ kind: 'worktree-file', path: 'a.txt', bytes: text('x') }],
    });
    expect(error.message).toContain('no working tree');
  });
});

describe('a bundle that opens but cannot be received is refused before the first write', () => {
  test('a ferret record that is not a record', async () => {
    const error = await refused({ record: 'not json' });
    expect(error).toMatchObject({ status: 400, code: 'bundle_refused' });
    expect(error.message).toContain('ferret record is not a record');
  });

  test('a record that names another harness than the manifest', async () => {
    const error = await refused({ recordHarness: 'codex' });
    expect(error.message).toContain('two different harnesses');
  });

  test('a bundle with no working tree to put the conversation in', async () => {
    const error = await refused({ worktree: null });
    expect(error).toMatchObject({ status: 409, code: 'move_refused' });
  });

  test('a project that lacks the commit, and no commits in the bundle to give it', async () => {
    const error = await refused({ worktree: { head: NO_HEAD, branch: 'main' } });
    expect(error).toMatchObject({ status: 409, code: 'commit_missing' });
  });

  test('a folder for the working tree that is already taken', async () => {
    const { target, pushed } = await fixtureWorld({
      wrapCheckout: real => ({ ...real, isFree: async () => false }),
    });
    const before = target.shape();
    const made = await craft(target, { worktree: { head: pushed, branch: 'feature' } });
    const error = await refusal(
      target.importer.import(made.offerId, { header: made.header, sourceDaemonId: made.header.sourceDaemonId }),
    );
    expect(error).toMatchObject({ status: 409, code: 'folder_taken' });
    expect(target.shape()).toEqual(before);
  });

  test('a clone that does not have the commit, and the clone it made is taken back', async () => {
    const fixture = makeRepository();
    const target = await targetWorld({ project: false, accounts: 1 }, fixture.remote);
    const cloneInto = join(target.root, 'clones');
    mkdirSync(cloneInto);
    const before = target.shape();
    const made = await craft(target, { worktree: { head: NO_HEAD, branch: 'main' } });
    const error = await refusal(
      target.importer.import(made.offerId, {
        header: made.header,
        sourceDaemonId: made.header.sourceDaemonId,
        cloneInto,
      }),
    );
    expect(error).toMatchObject({ status: 409, code: 'commit_missing' });
    expect(target.registered).toHaveLength(0);
    expect(target.removedProjects).toEqual([]);
    expect(target.shape()).toEqual(before);
  });

  test('Projects is only consulted during the read-only preflight', async () => {
    const fixture = makeRepository();
    const target = await targetWorld({ project: false, accounts: 1, projectsGoneAfterLook: true }, fixture.remote);
    const cloneInto = join(target.root, 'clones');
    mkdirSync(cloneInto);
    const pushed = git(fixture.folder, 'rev-parse', 'HEAD~1').trim();
    const made = await craft(target, { worktree: { head: pushed, branch: 'main' } });
    const done = await target.importer.import(made.offerId, {
      header: made.header,
      sourceDaemonId: made.header.sourceDaemonId,
      cloneInto,
    });
    expect(done.ferretId).toBeDefined();
    expect(target.started.length).toBe(1);
  });

  test('a harness that falls over while it starts leaves nothing this import made', async () => {
    const { target, pushed } = await fixtureWorld({ start: 'throw' });
    const before = target.shape();
    const made = await craft(target, { worktree: { head: pushed, branch: 'feature' } });
    const error = await refusal(
      target.importer.import(made.offerId, { header: made.header, sourceDaemonId: made.header.sourceDaemonId }),
    );
    expect(error).toMatchObject({ status: 409, code: 'move_failed' });
    expect(error.message).toContain('fell over');
    expect(target.shape()).toEqual(before);
  });
});

describe('where a working tree stands', () => {
  test('a branch the project does not have is made under its own name, on the commit the ferret was on', async () => {
    const { target, pushed } = await fixtureWorld();
    const made = await craft(target, { worktree: { head: pushed, branch: 'feature' }, runtime: 'claude-default' });
    const done = await target.importer.import(made.offerId, {
      header: made.header,
      sourceDaemonId: made.header.sourceDaemonId,
    });
    expect(git(done.folder, 'branch', '--show-current').trim()).toBe('feature');
    expect(git(done.folder, 'rev-parse', 'HEAD').trim()).toBe(pushed);
    expect(target.started[0]?.runtime).toBe('claude-default');
  });

  test('a ferret on a detached head gets a detached working tree', async () => {
    const { target, pushed } = await fixtureWorld();
    const made = await craft(target, { worktree: { head: pushed } });
    const done = await target.importer.import(made.offerId, {
      header: made.header,
      sourceDaemonId: made.header.sourceDaemonId,
    });
    expect(git(done.folder, 'branch', '--show-current').trim()).toBe('');
    expect(git(done.folder, 'rev-parse', 'HEAD').trim()).toBe(pushed);
  });
});

describe('what this machine says it can take', () => {
  const needs = { harness: 'claude-code', remote: normalizeRemote(REMOTE_URL), secrets: [] as string[] };

  test('with Projects off, the project cannot be found', async () => {
    const { target } = await fixtureWorld({ projectsOff: true });
    const offer = await target.offers.open();
    const looked = await target.importer.preflight(offer.offerId, { needs });
    expect(looked.ok).toBe(false);
    expect(looked.refusals.join(' ')).toContain('Projects is off on this machine');
  });

  test('a clone folder that already holds the repository’s name is refused', async () => {
    const fixture = makeRepository();
    const target = await targetWorld({ project: false, accounts: 1 }, fixture.remote);
    const cloneInto = join(target.root, 'clones');
    mkdirSync(join(cloneInto, 'project'), { recursive: true });
    const offer = await target.offers.open();
    const looked = await target.importer.preflight(offer.offerId, { needs, cloneInto });
    expect(looked.ok).toBe(false);
    expect(looked.refusals.join(' ')).toContain('already exists');
  });

  test('with Runtimes off, there is no login to run the ferret on', async () => {
    const { target } = await fixtureWorld({ runtimesOff: true });
    const offer = await target.offers.open();
    const looked = await target.importer.preflight(offer.offerId, { needs });
    expect(looked.ok).toBe(false);
    expect(looked.refusals.join(' ')).toContain('Runtimes is off on this machine');
  });
});

describe('the offers this machine opens', () => {
  test('a second offer cannot be opened while one is waiting', async () => {
    const { target } = await fixtureWorld();
    await target.offers.open();
    expect(target.offers.open()).rejects.toMatchObject({ code: 'offer_busy' });
  });

  test('two offers opened at the same moment: one is admitted, the other is told to wait', async () => {
    const { target } = await fixtureWorld();
    const both = await Promise.allSettled([target.offers.open(), target.offers.open()]);
    expect(both.filter(each => each.status === 'fulfilled')).toHaveLength(1);
    const lost = both.find(each => each.status === 'rejected');
    expect(lost).toMatchObject({ reason: { code: 'offer_busy' } });
  });

  test('an empty chunk is refused', async () => {
    const { target } = await fixtureWorld();
    const offer = await target.offers.open();
    expect(() => target.importer.receive(offer.offerId, 0, new Uint8Array(0))).toThrow(/chunk size/u);
  });
});

describe('the checkout reads a path it cannot look at as not free', () => {
  test('a kernel that cannot look says no, never yes', async () => {
    const checkout = kernelCheckout({
      roots: {
        root: () => ({
          resolve: () => ({ ok: true, value: 'x' }),
          lstat: async () => {
            throw new Error('unreadable');
          },
        }),
      },
      spawn: {},
    } as never);
    expect(await checkout.isFree('/somewhere/x')).toBe(false);
  });
});
