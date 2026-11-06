import { join } from 'node:path';
import { MACHINE_AGENDA_ID } from '@ferretry/protocol';
import { LOGIN_SECRETS_DOCUMENT, SECRETS_DOCUMENT, type SystemClock } from '../../src/adapters/index.ts';
import type { FileAgendaLedgerRepository } from '../../src/adapters/agenda/file-agenda-ledger-repository.ts';
import type { FileBoardStore } from '../../src/adapters/board/file-board-store.ts';
import type { EphemeralAwareRedactor, FileSystemPort, FoundationPaths, LaneSetService } from '../../src/lib/index.ts';
import type { FileEventHub } from '../../src/lib/file-events/index.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import { workSearchContribution } from '../../src/lib/runtime/mounts/work-search.ts';
import { WorkSearchService } from '../../src/lib/work-search/index.ts';

/**
 * ONE search over every card and agenda item (docs/work-search.md): the finder, `fy search` and the related check.
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter
 * that `DaemonWorld` carries), no jobs armed by `start()` and no releases. It starts two things while it is built,
 * which stay inside `build` at the point they always had (plan §3.4, named exception): the board store's directory
 * watch and the timer that builds the index a few seconds after boot. The watch is closed by the file-event hub at
 * shutdown and the timer is only `unref`ed, as before.
 */

/** How long after boot the work search builds its index: after the boot's own reads, before anyone searches. */
const WORK_SEARCH_WARM_DELAY_MS = 5_000;

/** What the work-search module is built from. */
export interface WorkSearchNeeds {
  /** The state home's directories: the vault documents whose change rebuilds the index live under `state`. */
  readonly paths: Pick<FoundationPaths, 'state'>;
  /** The state home's confined filesystem; the file identities of the secret and login vault documents. */
  readonly stateFiles: Pick<FileSystemPort, 'identity'>;
  /** The board's cards, read from its in-memory store; a card file edited by hand reaches the search through its watch. */
  readonly board: Pick<FileBoardStore, 'read' | 'watch'>;
  /** Each project's lanes, which say which cards are open. */
  readonly laneSets: Pick<LaneSetService, 'laneSet'>;
  /** Every session directory that may hold an agenda, whatever the session index still says about it. */
  readonly agendaSessionIds: () => Promise<readonly string[]>;
  /** The session agendas' ledgers, read through their own cache. */
  readonly agendaBoards: Pick<FileAgendaLedgerRepository, 'read'>;
  /** The machine agenda's ledger. */
  readonly machineBoards: Pick<FileAgendaLedgerRepository, 'read'>;
  /** Indexes only scrubbed text. */
  readonly secretRedactor: Pick<EphemeralAwareRedactor, 'batch'>;
  /** Hears the card directory change. */
  readonly fileEvents: Pick<FileEventHub, 'subscribeDirectory'>;
  readonly clock: Pick<SystemClock, 'now'>;
}

export const workSearchModule: DaemonModule<void, WorkSearchNeeds, WorkSearchService> = {
  id: 'workSearch',
  build: needs => {
    const { paths, stateFiles, board, laneSets, agendaSessionIds, agendaBoards, machineBoards } = needs;
    const { secretRedactor, fileEvents, clock } = needs;
    // ONE search over every card and agenda item (docs/work-search.md): the finder, `fy search` and the related
    // check. It reads the board store's in-memory cards and the agenda ledgers through their own caches, indexes
    // only scrubbed text, and rebuilds whenever the secret or login vault file changes (its epoch).
    const workSearch = new WorkSearchService({
      cards: {
        cards: async () => (await board.read()).cards,
        laneSet: async projectId => await laneSets.laneSet(projectId),
      },
      agenda: {
        sessions: async () => [...(await agendaSessionIds()), MACHINE_AGENDA_ID],
        ledger: async sessionId =>
          await (sessionId === MACHINE_AGENDA_ID ? machineBoards : agendaBoards).read(sessionId),
      },
      redaction: {
        batch: async work => await secretRedactor.batch(scrub => work(text => scrub.text(text))),
        epoch: async () =>
          (
            await Promise.all(
              [SECRETS_DOCUMENT, LOGIN_SECRETS_DOCUMENT].map(
                async name => (await stateFiles.identity?.(join(paths.state, name))) ?? '-',
              ),
            )
          ).join('|'),
      },
      now: () => Date.parse(clock.now()),
      warn: message => process.stderr.write(`${message}\n`),
    });
    // A card file edited by hand reaches the board (and so the search) as soon as its directory says so; the hub
    // closes the watch at shutdown. The index is built a few seconds after boot, off the boot path, so the
    // first search rarely waits for it.
    board.watch((directory, listener) => fileEvents.subscribeDirectory(directory, () => listener()));
    setTimeout(() => workSearch.warm(), WORK_SEARCH_WARM_DELAY_MS).unref();
    return {
      id: 'workSearch',
      provides: workSearch,
      jobs: {},
      contributes: workSearchContribution(workSearch),
    };
  },
};
