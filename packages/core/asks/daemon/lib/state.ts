/** Asks' private state is declared in the manifest (a manifest imports only contracts); the engine's names for it. */
export {
  AGENDA_STATE_FILES,
  AgendaHistoryFiles,
  AgendaHistoryMarkFiles,
  AgendaLedgerFiles,
  AgendaPendingChangesFiles,
  AgendaPendingVersionsFiles,
  AgendaRepliesFiles,
  AgendaSeenFiles,
  AgendaSetAsideFiles,
  ASKS_STATE,
} from '../../manifest.ts';

/** The name a version archive goes by in `versions/*.sqlite`: the ferret and the ask (`<ferret>~A12`). */
export const versionArchiveName = (sessionId: string, askId: string): string => `${sessionId}~${askId}`;
