import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FerretId, HarnessKey, StartRequest } from '@ferretry/core-ferrets/contract';
import { err, ok, type Instant } from '@ferretry/std';
import { toBase64Url } from '@ferretry/std/sealing';
import { OfferBook } from '../../daemon/lib/offer.ts';
import { type Checkout, kernelCheckout } from '../../daemon/lib/checkout.ts';
import { Importer, type ImporterDeps } from '../../daemon/lib/import.ts';
import { normalizeRemote } from '../../daemon/lib/remote.ts';
import { offerSignedBytes } from '../../contract/index.ts';
import { crypto, newIdentity } from './identity.ts';
import { git, REMOTE_URL, realKernel } from './real-git.ts';
import type { World } from './world.ts';
import { FERRET } from './fake-ferrets.ts';

const NORMAL_REMOTE = normalizeRemote(REMOTE_URL) as string;
export const NEW_FERRET = 'f-on-b' as FerretId;

export interface TargetOptions {
  /** `false`: no registered project has the remote (so a clone, or a refusal, is what is left). */
  readonly project?: boolean;
  readonly accounts?: number;
  readonly secrets?: readonly string[];
  readonly harnesses?: readonly string[];
  readonly runtimeOk?: boolean;
  readonly start?: 'ok' | 'refuse' | 'throw';
  /** Projects, or Runtimes, is off on this machine (its plugin is not loaded). */
  readonly projectsOff?: boolean;
  readonly runtimesOff?: boolean;
  /** Projects answers the preflight and is gone by the time the import writes. */
  readonly projectsGoneAfterLook?: boolean;
  /** The ledger that says where a ferret came from cannot be written. */
  readonly recordFails?: boolean;
  /** Wraps the real checkout, so a test can make one step fail. */
  readonly wrapCheckout?: (real: Checkout) => Checkout;
  /** Mutates the clock the target and its offers share. */
  readonly nowMs?: number;
}

/** What a target machine holds that a move could change: the project's refs and working trees, and the folders beside it. */
interface Shape {
  readonly folders: readonly string[];
  readonly worktrees: string;
  readonly refs: string;
}

export interface TargetWorld {
  readonly importer: Importer;
  readonly offers: OfferBook;
  readonly started: StartRequest[];
  readonly stopped: string[];
  readonly recorded: Map<string, { daemonId: string; ferretId: string; at: Instant }>;
  readonly registered: string[];
  readonly removedProjects: string[];
  readonly daemonId: string;
  readonly root: string;
  readonly repo: string;
  readonly remoteBare: string;
  now: number;
  shape(): Shape;
  /** Opens an offer here, has `source` seal its ferret to it, and uploads the chunks: everything the app carries. */
  carry(
    source: World,
    options?: { readonly upload?: boolean },
  ): Promise<{
    readonly offerId: string;
    readonly header: import('../../contract/index.ts').BundleHeader;
    readonly chunks: readonly Uint8Array[];
  }>;
}

/** One target machine: its own clone of the project on a real disk, real git, and fakes for the neighbours it asks. */
export async function targetWorld(options: TargetOptions = {}, remoteBare?: string): Promise<TargetWorld> {
  const root = mkdtempSync(join(tmpdir(), 'relocate-target-'));
  const machine = join(root, 'machine');
  mkdirSync(machine, { recursive: true });
  const repo = join(machine, 'project');
  const identity = await newIdentity();
  const started: StartRequest[] = [];
  const stopped: string[] = [];
  const recorded = new Map<string, { daemonId: string; ferretId: string; at: Instant }>();
  const registered: string[] = [];
  const removedProjects: string[] = [];
  const bare = remoteBare ?? '';
  const havingProject = options.project ?? true;
  if (havingProject && bare !== '') {
    git(machine, 'clone', '-q', bare, repo);
    git(repo, 'remote', 'set-url', 'origin', REMOTE_URL);
  }
  const looks = { count: 0 };
  const self = { now: options.nowMs ?? Date.parse('2026-11-27T12:00:00.000Z') } as { now: number };
  const clock = {
    now: () => new Date(self.now).toISOString() as Instant,
    nowMs: () => self.now,
  };
  const offers = new OfferBook({
    crypto,
    clock,
    signer: {
      signRelocateOffer: async request => {
        const identityKey = toBase64Url(identity.publicKeySpki);
        const unsigned = {
          ...request,
          v: 1 as const,
          daemonId: identity.daemonId,
          identityKey,
          expiresAt: request.expiresAt as Instant,
        };
        const signature = await crypto.signEd25519(identity.privateKey, offerSignedBytes(unsigned));
        return {
          daemonId: identity.daemonId,
          identityKey,
          signature: toBase64Url(signature),
        };
      },
    },
  });
  const realCheckout = kernelCheckout(realKernel());
  const deps: ImporterDeps = {
    crypto,
    ownDaemonId: identity.daemonId,
    clock,
    offers,
    ferrets: {
      harnesses: () => (options.harnesses ?? ['claude-code']) as readonly HarnessKey[],
      start: async request => {
        started.push(request);
        if (options.start === 'throw') throw new Error('the harness fell over');
        return options.start === 'refuse'
          ? err({ code: 'refused', reason: 'the moved conversation was refused by the harness' })
          : ok(NEW_FERRET);
      },
      stop: async ferret => {
        stopped.push(ferret);
      },
    },
    projects: () =>
      options.projectsOff === true || (options.projectsGoneAfterLook === true && looks.count++ > 0)
        ? undefined
        : ({
            list: async () =>
              havingProject
                ? [
                    {
                      id: 'p1',
                      name: 'project',
                      path: repo,
                      source: 'clone',
                      createdAt: '2026-11-01T00:00:00.000Z',
                      repos: [{ path: '.', remote: NORMAL_REMOTE }],
                    },
                  ]
                : [],
            register: async (request: { readonly kind: string; readonly path: string }) => {
              if (request.kind !== 'clone') return err({ code: 'registration_failed', message: 'only clones here' });
              registered.push(request.path);
              git(machine, 'clone', '-q', bare, request.path);
              return ok({ id: 'p-cloned', name: 'cloned', path: request.path });
            },
            remove: async (id: string) => {
              removedProjects.push(String(id));
              return ok({ id, name: 'cloned', path: '' });
            },
          } as never),
    gitAccounts: () =>
      ({
        list: async () => Array.from({ length: options.accounts ?? 1 }, (_, n) => ({ id: `a${String(n)}` })),
      }) as never,
    runtimes: () =>
      options.runtimesOff === true
        ? undefined
        : ({
            default: async () => 'claude-default',
            resolve: async () =>
              options.runtimeOk === false
                ? { ok: false, refusal: 'no_login', sentence: 'no login is signed in' }
                : {
                    ok: true,
                    runtime: {
                      id: 'claude-default',
                      harness: 'claude-code',
                      login: 'l',
                      profile: 'p',
                      launch: { available: true },
                    },
                  },
          } as never),
    vault: () => ({ has: async (name: string) => (options.secrets ?? []).includes(name) }) as never,
    checkout: options.wrapCheckout === undefined ? realCheckout : options.wrapCheckout(realCheckout),
    received: {
      record: async (ferret, entry) => {
        if (options.recordFails === true) throw new Error('ledger down');
        recorded.set(ferret, entry);
      },
    },
    log: { warn: () => {} },
  };
  const importer = new Importer(deps);
  const shape = (): Shape => ({
    folders: readdirSync(machine).sort(),
    worktrees: havingProject ? git(repo, 'worktree', 'list', '--porcelain') : '',
    refs: havingProject ? git(repo, 'for-each-ref') : '',
  });
  return Object.assign(self, {
    importer,
    offers,
    started,
    stopped,
    recorded,
    registered,
    removedProjects,
    daemonId: identity.daemonId,
    root: machine,
    repo,
    remoteBare: bare,
    shape,
    carry: async (source: World, carryOptions: { readonly upload?: boolean } = {}) => {
      source.now = self.now;
      const offer = await offers.open();
      const exported = await source.relocation.export(FERRET, offer);
      const chunks = Array.from({ length: exported.header.chunks }, (_, index) =>
        source.relocation.chunk(exported.exportId, index),
      );
      if (carryOptions.upload !== false)
        for (const [index, chunk] of chunks.entries()) importer.receive(offer.offerId, index, chunk);
      return { offerId: offer.offerId, header: exported.header, chunks };
    },
  }) as unknown as TargetWorld;
}
