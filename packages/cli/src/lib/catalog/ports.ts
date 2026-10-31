import type {
  AddCatalogItemRequest,
  CatalogItemPreview,
  CatalogItemPreviewRequest,
  CreateCatalogRequest,
  DeletedCatalog,
  ExportCatalogRequest,
  IFyApiClient,
  OwnedCatalog,
  OwnedCatalogList,
  PublishCatalogVersionRequest,
  PublishedCatalogItem,
  SharedCatalogFile,
  UpdateCatalogRequest,
  WithdrawnCatalogItem,
} from '@ferretry/protocol';

/** Presentation port for `fy catalog` — the narrowest slice of the shipped `ConsoleIo` adapter. */
export interface ICatalogOutput {
  success(message: string): void;
  warn(message: string): void;
  /** Uncoloured stderr for JSON evidence that must not corrupt the final stdout payload. */
  diagnostic(message: string): void;
}

/** Typed y/N input, injected so a test never blocks on a terminal. */
export interface ICatalogPrompt {
  ask(message: string): Promise<string>;
}

/** The owner routes of the daemon (docs/catalogs.md § The publisher side). */
export interface ICatalogGateway {
  /** With `sourceState`, the daemon also re-reads every source to say whether it changed. */
  list(options?: { readonly sourceState: boolean }): Promise<OwnedCatalogList>;
  create(request: CreateCatalogRequest): Promise<OwnedCatalog>;
  update(catalogId: string, request: UpdateCatalogRequest): Promise<OwnedCatalog>;
  remove(catalogId: string): Promise<DeletedCatalog>;
  preview(catalogId: string, request: CatalogItemPreviewRequest): Promise<CatalogItemPreview>;
  add(catalogId: string, request: AddCatalogItemRequest): Promise<PublishedCatalogItem>;
  publishVersion(
    catalogId: string,
    itemId: string,
    request: PublishCatalogVersionRequest,
  ): Promise<PublishedCatalogItem>;
  withdraw(catalogId: string, itemId: string): Promise<WithdrawnCatalogItem>;
  export(catalogId: string, request: ExportCatalogRequest): Promise<SharedCatalogFile>;
}

/** Where an exported catalog file is written. */
export interface ICatalogFileWriter {
  exists(path: string): Promise<boolean>;
  /**
   * Writes the whole file; with `overwrite` false it fails rather than replace one that is there. Replacing goes through a
   * temporary file beside it and a rename, and refuses a path that is a symbolic link.
   */
  write(path: string, text: string, overwrite: boolean): Promise<void>;
}

/** The only client capability the catalog gateway consumes. */
export type CatalogApiClient = Pick<IFyApiClient, 'request'>;
