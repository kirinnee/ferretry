import type { IFyApiClient } from '@ferretry/protocol';

/** The four installer calls the protocol client already owns and validates. */
export type ICatalogInstallGateway = Pick<
  IFyApiClient,
  'previewCatalogInstall' | 'applyCatalogInstall' | 'catalogInstalls' | 'removeCatalogInstall'
>;

/** Reading a catalog file: its size first, so an oversized file is never read at all. */
export interface ICatalogFileReader {
  size(path: string): Promise<number>;
  read(path: string): Promise<string>;
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
