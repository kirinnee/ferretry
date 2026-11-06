import { sharedHistoryPoolDirectory } from '@ferretry/fleet';
import {
  NodeConversationFiles,
  StorageConversationOwners,
} from '../../src/adapters/imports/node-conversation-files.ts';
import { foreignHistoryRoots } from '../../src/adapters/imports/node-foreign-history-files.ts';
import type { DaemonStorage } from '../../src/adapters/storage/session-storage.ts';
import { WorkerConversationDescriber, WorkerForeignTranscriptReader } from '../../src/adapters/transcript/index.ts';
import type { TranscriptParseWorker } from '../../src/adapters/transcript/index.ts';
import {
  AccountModelConversationListPolicy,
  type ConversationAdopter,
  ConversationImportService,
  type ConversationSettingsReader,
  computerConversationRoots,
  FileConversationDescriber,
  FileForeignTranscriptReader,
  type ForeignHistoryFiles,
  ForeignHistoryImporter,
  type PacedTranscriptParser,
  type TranscriptHarness,
} from '../../src/lib/index.ts';
import type { HandoffScope } from '../../src/lib/imports/conversation-text.ts';
import type { DaemonModule } from '../../src/lib/runtime/modules.ts';
import type { ConversationImportSubsystem } from '../../src/lib/runtime/mounts/conversation-import.ts';
import type { ForeignHistorySubsystem } from '../../src/lib/runtime/mounts/foreign-history.ts';
import { importsContribution } from '../../src/lib/runtime/mounts/imports.ts';

/**
 * The owner's existing conversations: the read-only foreign history of the CLIs' own homes (`/v1/imports/history`) and
 * the import that keeps a conversation as a ferret (`/v1/imports/conversations`).
 *
 * See `./learning.ts` for what a module file owns. This module has no `Seams` (it replaces no production adapter that
 * `DaemonWorld` carries: the file readers and the linker are fixed production adapters; the transcript worker, the
 * paced parsers, the storage and the adopter are needs), no jobs and no releases of its own: every constructor here is
 * pure (it captures its inputs and reads nothing), so one build sits where the conversation import used to be
 * assembled. The foreign history importer used to be assembled earlier, in `buildWorld`; it only captures its inputs
 * too, so no observable order changes.
 *
 * WHAT STAYS IN `fyd.ts`: the adopter. Adopting a conversation IS a session start (the same account resolution,
 * callsign claim, plan and lifecycle), so it shares the start's helpers and is session code that moves with the
 * sessions module; it arrives here as {@link ConversationImportNeeds.adopter}.
 */

/** What the conversation-import module is built from. */
export interface ConversationImportNeeds {
  /** Opened session storage: the import reads which conversations a session already owns through it. */
  readonly storage: DaemonStorage;
  /** The user's home directory: the CLIs' own homes, and the foreign history's roots, hang off it. */
  readonly userHome: string;
  /** The state home's fleet directory: Ferretry's shared history pools live under it. */
  readonly fleetDirectory: string;
  /**
   * The environment the computer's own homes are read from (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), read when the module
   * is built.
   */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The one thread every transcript read is parsed on; a read falls back to the paced parsers when it is unavailable. */
  readonly transcriptWorker: TranscriptParseWorker;
  /** The paced parsers, for the readers that hold a whole transcript as text. */
  readonly parsers: Readonly<Record<TranscriptHarness, PacedTranscriptParser>>;
  /** Where an import listing may read a transcript's hand-off pointer from; the worker was told the same scope. */
  readonly handoffScope: HandoffScope;
  /** The foreign history's filesystem: it has no mutation method, so a foreign history can never be written. */
  readonly foreignHistoryFiles: ForeignHistoryFiles;
  /** The machine's account model, freshly read: whether a listing includes this computer's own homes. */
  readonly accountModel: ConversationSettingsReader;
  /** Keeps a conversation as a ferret: the start pipeline minus the parts that would make a NEW conversation. */
  readonly adopter: ConversationAdopter;
}

/** What other code reads off the conversation-import module. Nothing outside it reads either service today. */
export interface ConversationImportProvides {
  readonly foreignHistory: ForeignHistorySubsystem;
  readonly conversationImport: ConversationImportSubsystem;
}

export const conversationImportModule: DaemonModule<void, ConversationImportNeeds, ConversationImportProvides> = {
  id: 'conversationImport',
  build: needs => {
    const { storage, userHome, fleetDirectory, environment, transcriptWorker, parsers, handoffScope } = needs;
    /**
     * A separate read surface for conversations that existed before Ferretry.
     *
     * It shares the exact parser instances used by managed sessions, but its filesystem capability
     * has no mutation method and it is deliberately not backed by the session store: a foreign JSONL
     * has neither a Ferretry journal nor a live pane and must never be presented as resumable.
     */
    const foreignHistory = new ForeignHistoryImporter(
      needs.foreignHistoryFiles,
      foreignHistoryRoots(userHome),
      new WorkerForeignTranscriptReader(
        transcriptWorker,
        new FileForeignTranscriptReader(needs.foreignHistoryFiles, parsers),
      ),
    );
    /**
     * The owner's existing conversations, found in Ferretry's shared history FIRST (where every
     * runtime already sees them, and what Continue lists) and then in the CLI's own home on this
     * computer, as the daemon inherited it (which only importing lists). Read through the same
     * parsers managed sessions use; adopted through the same start machinery. A transcript's hand-off
     * pointer is read back only from a session's own folder, or as an agent coordinator's turn file
     * (`~/.<coordinator>/<agent>/turns/turn-NNN.md`, kteam's layout).
     */
    const conversationFiles = new NodeConversationFiles();
    const conversationImport = new ConversationImportService(
      conversationFiles,
      [
        { harness: 'claude', home: sharedHistoryPoolDirectory(fleetDirectory, 'claude'), source: 'ferretry' },
        { harness: 'codex', home: sharedHistoryPoolDirectory(fleetDirectory, 'codex'), source: 'ferretry' },
        ...computerConversationRoots({
          claudeConfigDir: environment.CLAUDE_CONFIG_DIR,
          codexHome: environment.CODEX_HOME,
          userHome,
        }),
      ],
      // Read and described on the transcript worker, which was told the same hand-off scope.
      new WorkerConversationDescriber(
        transcriptWorker,
        new FileConversationDescriber(conversationFiles, parsers, handoffScope),
      ),
      new StorageConversationOwners(storage),
      needs.adopter,
      new AccountModelConversationListPolicy(needs.accountModel),
    );
    return {
      id: 'conversationImport',
      provides: { foreignHistory, conversationImport },
      jobs: {},
      contributes: importsContribution({ foreignHistory, conversationImport }),
    };
  },
};
