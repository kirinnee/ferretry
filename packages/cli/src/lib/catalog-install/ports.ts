import type { IFyApiClient } from '@ferretry/protocol';

/** The four installer calls the protocol client already owns and validates. */
export type ICatalogInstallGateway = Pick<
  IFyApiClient,
  'previewCatalogInstall' | 'applyCatalogInstall' | 'catalogInstalls' | 'removeCatalogInstall'
>;

/**
 * Reading a catalog file: its size first, so an oversized file is never read at all. The read is bounded
 * too (at most `maxBytes`, refused if the file is longer), because the size can change after it was asked.
 */
export interface ICatalogFileReader {
  size(path: string): Promise<number>;
  read(path: string, maxBytes: number): Promise<string>;
}

/** Terminal output used by `fy catalog install`. */
export interface ICatalogInstallOutput {
  report(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** Asking a person a question at a terminal. */
export interface ICatalogInstallPrompt {
  ask(message: string): Promise<string>;
}
