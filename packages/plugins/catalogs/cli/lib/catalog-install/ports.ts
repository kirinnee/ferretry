import type { PluginClient } from '@ferretry/kernel/manifest';
import type {
  CatalogInstalled,
  CatalogInstallList,
  CatalogInstallPreview,
  CatalogInstallPreviewRequest,
  CatalogInstallRemoved,
  CatalogInstallRequest,
  CatalogInstallScope,
} from '../../../contract/wire/index.ts';

/** Today's four installer calls of the protocol client, each validated. */
export interface ICatalogInstallGateway {
  /** Verify a signed catalog item and answer its review. Writes nothing. */
  previewCatalogInstall(
    scope: CatalogInstallScope,
    request: CatalogInstallPreviewRequest,
  ): Promise<CatalogInstallPreview>;
  /** Install exactly one reviewed preview, binding each placeholder to one of the caller's own secrets or to nothing. */
  applyCatalogInstall(scope: CatalogInstallScope, request: CatalogInstallRequest): Promise<CatalogInstalled>;
  /** What this machine installed from catalogs. */
  catalogInstalls(): Promise<CatalogInstallList>;
  /** Remove exactly what one install wrote. */
  removeCatalogInstall(scope: CatalogInstallScope, installId: string): Promise<CatalogInstallRemoved>;
}

/** The only client capability the install gateway consumes. */
export type CatalogInstallApiClient = Pick<PluginClient, 'call'>;

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
  /** Uncoloured stderr for JSON evidence (the preview) that must not corrupt the final stdout payload. */
  diagnostic(message: string): void;
  setExitCode(code: number): void;
}

/** Asking a person a question at a terminal. */
export interface ICatalogInstallPrompt {
  ask(message: string): Promise<string>;
}
