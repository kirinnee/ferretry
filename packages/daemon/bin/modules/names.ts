import { SessionConfigSchema } from '@ferretry/protocol';
import { join } from 'node:path';
import { FileNameClaimStore, FileSystemCallsignCounters } from '../../src/adapters/names/index.ts';
import type { DaemonStorage } from '../../src/adapters/storage/session-storage.ts';
import {
  type FileSystemPort,
  type FoundationPaths,
  type NameAllocationRequest,
  type NameAllocationResult,
  NameAllocator,
  type NameClaim,
  type SerialExecutor,
  SystemCallsignIssuer,
  sessionNameClaim,
} from '../../src/lib/index.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import { type NameSubsystem, nameRoutes } from '../../src/lib/runtime/mounts/names.ts';

/**
 * The callsigns the fleet answers to: the claim ledger a start and a rename take names through, the issuer of the
 * ids system sessions take instead of a pool name, and the free-name suggestions (`GET /v1/names`).
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter that
 * `DaemonWorld` carries: the claim ledger, the callsign counters and the allocator's randomness are fixed production
 * adapters; the session storage, the state files and the ledger's executor are needs), no jobs and no releases of its
 * own: every constructor here is pure (it captures its inputs and reads nothing), so the single build sits where the
 * claims used to be assembled.
 *
 * What it provides is read by session launch and rename code that stays in `fyd.ts`: {@link NamesProvides.claims}
 * (a start takes a name through it, and gives it back when the start never happened) and
 * {@link NamesProvides.systemCallsigns} (the Learning miner and Pack clean-up take their ids from it).
 */

/**
 * Callsign claiming, as a START needs it: take a name, and give one back when the start it was taken
 * for never happened.
 *
 * The two halves come from different objects — the allocator decides, the ledger persists — and this
 * is the pair the composition root hands over, so the mount's own dependency is the capability rather
 * than two collaborators it would have to know how to assemble.
 */
export interface CallsignClaims {
  allocate(request: NameAllocationRequest): Promise<NameAllocationResult>;
  release(callsign: string, ownerId: string): Promise<void>;
}

/** What the names module is built from. */
export interface NamesNeeds {
  /** The slice of session storage that says which names the fleet holds: live sessions, their config, and the archive. */
  readonly storage: Pick<DaemonStorage, 'listSessions' | 'readConfig' | 'listArchivedSessions'>;
  /** The state home's files: the claim ledger and the system-callsign counters live there. */
  readonly stateFiles: FileSystemPort;
  /** The state home's directories. */
  readonly paths: FoundationPaths;
  /** ONE executor for the callsign ledger: what makes a claim atomic across concurrent starts. */
  readonly serial: SerialExecutor;
}

/** What other code reads off the names module. */
export interface NamesProvides {
  /** ONE claim surface over the ledger for the start and the rename, so both take names through the same allocator and the same file. */
  readonly claims: CallsignClaims;
  /** System sessions (the Learning miner, Pack clean-up) take ids of their own, never a pool name. */
  readonly systemCallsigns: SystemCallsignIssuer;
}

/**
 * The names the fleet is holding, derived from each session's own configuration document.
 *
 * This is the DURABLE half of "what is taken": a session's `teammate` is what a bare callsign
 * resolves through, so a name a session holds is not free however the reservation ledger looks. How
 * long a session holds its name — for as long as it is live, and for the resolution window after it
 * ends — is `sessionNameClaim`'s decision. Shared by the suggestion route and the allocator's claim
 * store so the two cannot disagree about who owns a name.
 */
async function liveCallsigns(storage: NamesNeeds['storage']): Promise<readonly NameClaim[]> {
  const sessions = await Promise.all(
    storage.listSessions().map(async (session): Promise<NameClaim | undefined> => {
      const config = SessionConfigSchema.safeParse(await storage.readConfig(session.id));
      if (!config.success) return undefined;
      return sessionNameClaim({
        id: session.id,
        ...(config.data.teammate === undefined ? {} : { teammate: config.data.teammate }),
        createdAt: config.data.createdAt,
        updatedAt: config.data.updatedAt,
        ...(session.status === undefined ? {} : { status: session.status }),
      });
    }),
  );
  // An archived session holds its name for the same window it always did: it left the live list, not the callsign's
  // five days, and `fy send <name>` still resolves to it, so the name must not be handed to a new session meanwhile.
  const archived = storage.listArchivedSessions().map(entry =>
    entry.configTimes === undefined
      ? undefined
      : sessionNameClaim({
          id: entry.id,
          ...(entry.name === undefined ? {} : { teammate: entry.name }),
          createdAt: entry.configTimes.createdAt,
          updatedAt: entry.configTimes.updatedAt,
          ...(entry.status === undefined ? {} : { status: entry.status }),
        }),
  );
  return [...sessions, ...archived].filter((claim): claim is NameClaim => claim !== undefined);
}

/**
 * Callsign claiming for a start: the real allocator over the reservation ledger and the live fleet.
 *
 * The randomness is the same rotation the suggestion route uses, and for the same reason — two starts
 * racing for the pool must not both begin at its first entry — and the ledger's executor is passed in
 * so every claim in the process serializes on the one file.
 */
function createCallsignClaims(
  storage: NamesNeeds['storage'],
  files: FileSystemPort,
  paths: FoundationPaths,
  executor: SerialExecutor,
): CallsignClaims {
  const store = new FileNameClaimStore(
    join(paths.state, 'callsigns.json'),
    files,
    executor,
    async () => await liveCallsigns(storage),
  );
  const allocator = new NameAllocator(store, {
    nextIndex: upperExclusive => Math.floor(Math.random() * upperExclusive),
  });
  return {
    allocate: async request => await allocator.allocate(request),
    release: async (callsign, ownerId) => await store.release(callsign, ownerId),
  };
}

function createNameSubsystem(storage: NamesNeeds['storage']): NameSubsystem {
  return {
    claims: async () => await liveCallsigns(storage),
    now: () => Date.now(),
    // Rotating the start so two humans asking at the same moment are not both offered the same
    // first name and then made to collide when they start their sessions.
    startIndex: upperExclusive => Math.floor(Math.random() * upperExclusive),
  };
}

export const namesModule: DaemonModule<void, NamesNeeds, NamesProvides> = {
  id: 'names',
  build: needs => {
    const { storage, stateFiles, paths, serial } = needs;
    const claims = createCallsignClaims(storage, stateFiles, paths, serial);
    const systemCallsigns = new SystemCallsignIssuer({
      counters: new FileSystemCallsignCounters(join(paths.state, 'system-callsigns.json'), stateFiles),
      held: async () => (await liveCallsigns(storage)).map(claim => claim.callsign),
      serial,
    });
    return {
      id: 'names',
      provides: { claims, systemCallsigns },
      jobs: {},
      contributes: { routes: nameRoutes(createNameSubsystem(storage)) },
    };
  },
};
