import type { DaemonIdentity } from '@ferretry/std/sealing';
import type { Instant } from '@ferretry/std';
import { kernelWorkingTree } from '../../daemon/lib/git-bundle.ts';
import { type MovedLedger, Relocation } from '../../daemon/lib/relocation.ts';
import { type FakeFerrets, fakeFerrets, fakeSource, type FakeSourceOptions } from './fake-ferrets.ts';
import { crypto, newIdentity, openOffer, type TestOffer } from './identity.ts';
import { makeRepository, realKernel, type Fixture } from './real-git.ts';

const NOW_MS = Date.parse('2026-11-27T12:00:00.000Z');

export interface World {
  readonly relocation: Relocation;
  readonly ferrets: FakeFerrets;
  readonly source: ReturnType<typeof fakeSource>;
  readonly fixture: Fixture;
  readonly sourceIdentity: DaemonIdentity;
  readonly targetIdentity: DaemonIdentity;
  readonly movedLedger: Map<string, { daemonId: string; ferretId: string; at: Instant }>;
  now: number;
  /** A fresh offer the target would open, good for five minutes from the world's clock. */
  offer(options?: {
    readonly tamper?: 'signature' | 'key';
    readonly offerId?: string;
    readonly ttlMs?: number;
  }): Promise<TestOffer>;
}

/** One source machine with a ferret in a real git working tree, a target identity, and a clock the test drives. */
export async function world(
  options: FakeSourceOptions & { readonly state?: 'idle' | 'working' | 'stopped'; readonly noTree?: boolean } = {},
): Promise<World> {
  const fixture = makeRepository();
  const source = fakeSource(options);
  const ferrets = fakeFerrets({
    state: options.state ?? 'idle',
    source,
    ...(options.noTree === true ? {} : { folder: fixture.folder }),
  });
  const sourceIdentity = await newIdentity();
  const targetIdentity = await newIdentity();
  const movedLedger = new Map<string, { daemonId: string; ferretId: string; at: Instant }>();
  const moved: MovedLedger = {
    get: async ferret => movedLedger.get(ferret),
    record: async (ferret, entry) => {
      movedLedger.set(ferret, entry);
    },
  };
  const kernel = realKernel();
  const self: World = {
    ferrets,
    source,
    fixture,
    sourceIdentity,
    targetIdentity,
    movedLedger,
    now: NOW_MS,
    relocation: new Relocation({
      crypto,
      ferrets: ferrets.port,
      treeOf: folder => kernelWorkingTree(kernel, folder),
      daemonId: sourceIdentity.daemonId,
      clock: { now: () => new Date(self.now).toISOString() as Instant, nowMs: () => self.now },
      moved,
      log: { warn: () => {} },
    }),
    offer: async (opts = {}) =>
      await openOffer(targetIdentity, {
        expiresAtMs: self.now + (opts.ttlMs ?? 5 * 60_000),
        ...(opts.tamper === undefined ? {} : { tamper: opts.tamper }),
        ...(opts.offerId === undefined ? {} : { offerId: opts.offerId }),
      }),
  };
  return self;
}
