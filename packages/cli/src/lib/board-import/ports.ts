import type { BoardImportSummary } from '@ferretry/protocol';

/** What `board import` needs from the daemon; the adapter that implements it knows the URL. */
export interface IBoardImportGateway {
  run(dryRun: boolean): Promise<BoardImportSummary>;
}

/** The slice of the terminal port the command uses; `ConsoleIo` satisfies it structurally. */
export interface IBoardImportOutput {
  success(message: string): void;
}
