import { FilePinSessionDirectory } from '../../src/adapters/pins/index.ts';
import { FileSharedDraftRepository } from '../../src/adapters/shared-drafts/index.ts';
import { KeyedSerialExecutor } from '../../src/adapters/index.ts';
import type { FileSystemPort, FoundationPaths } from '../../src/lib/index.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import type { PairingSubsystem } from '../../src/lib/runtime/mounts/pairing.ts';
import { sharedDraftsContribution } from '../../src/lib/runtime/mounts/shared-drafts.ts';
import {
  AgendaDraftSessions,
  type AgendaItemLedgers,
  SharedDraftPresence,
  SharedDraftService,
  type SharedDraftClock,
} from '../../src/lib/shared-drafts/index.ts';

/**
 * The owner's shared drafts: one session's unsent composer (and each agenda item's reply box), read and edited live
 * by the owner's own devices (`/v1/sessions/:sessionId/shared-draft` and its stream socket).
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter
 * that `DaemonWorld` carries: the draft repository, the write timer and the generation source are fixed production
 * adapters; the agenda ledgers, the clock and the paired devices are needs), no jobs and no releases of its own.
 *
 * The one release this subsystem has — a draft typed in the last second is written down before the daemon goes —
 * is registered by `start()` beside the kernel's other shutdown steps, on the line it always was, because its place
 * among them is a fact about the whole shutdown, not about drafts; it reads this module's `provides`.
 *
 * The service is a value the agenda's board observers read through a `LateBound` in `fyd.ts` (an item that
 * closes deletes its draft), bound right after `build`, on the line the service used to be assigned.
 */

/** What the shared-drafts module is built from. */
export interface SharedDraftsNeeds {
  readonly paths: FoundationPaths;
  readonly stateFiles: FileSystemPort;
  /** Which agenda items are open on a session's board: an item's reply box exists while the item does. */
  readonly agendaBoards: AgendaItemLedgers;
  /** Stamps a draft's writes. */
  readonly clock: SharedDraftClock;
  /** Names the paired device a live composer is open on. */
  readonly pairing: Pick<PairingSubsystem, 'devices'>;
}

export const sharedDraftsModule: DaemonModule<void, SharedDraftsNeeds, SharedDraftService> = {
  id: 'sharedDrafts',
  build: needs => {
    const { paths, stateFiles, agendaBoards, clock, pairing } = needs;
    const sharedDraftService = new SharedDraftService(
      new AgendaDraftSessions(new FilePinSessionDirectory(paths, stateFiles), agendaBoards),
      new FileSharedDraftRepository(paths, stateFiles, new KeyedSerialExecutor()),
      clock,
      {
        after: (milliseconds, action) => {
          const timer = setTimeout(action, milliseconds);
          return { cancel: () => clearTimeout(timer) };
        },
      },
      // A generation must never repeat across restarts, so it is random rather than counted.
      { next: () => crypto.randomUUID() },
    );
    return {
      id: 'sharedDrafts',
      provides: sharedDraftService,
      jobs: {},
      contributes: sharedDraftsContribution(sharedDraftService, {
        presence: new SharedDraftPresence(),
        deviceName: async deviceId => (await pairing.devices()).find(device => device.id === deviceId)?.name,
        nextPeer: () => crypto.randomUUID(),
        clock: { nowMs: () => Date.now() },
      }),
    };
  },
};
