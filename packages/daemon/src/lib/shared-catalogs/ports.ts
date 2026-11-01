/**
 * What the publisher side needs from the machine. Each is a port: the pure code in this folder never
 * reads a file, asks the inventory, or holds a key (docs/standards/three-layer-architecture).
 */
import type { DaemonIdentity } from '@ferretry/relay';
import type { CatalogsDocument } from './document.ts';
import type { CatalogsDocumentV1 } from './document-v1.ts';
import type { McpSourceServer } from './mcp-source.ts';

/**
 * What `state/catalogs/catalogs.json` holds. A version 1 file arrives with its exact text, because the
 * backup written before the upgrade is those bytes and no re-spelling of them.
 */
export type RawCatalogs =
  | { readonly version: 1; readonly doc: CatalogsDocumentV1; readonly text: string }
  | { readonly version: 2; readonly doc: CatalogsDocument }
  | { readonly version: 'none' };

/** `state/catalogs/catalogs.json`. A damaged file is an error from `readRaw`, never an empty document. */
export interface CatalogDocumentStore {
  readRaw(): Promise<RawCatalogs>;
  write(document: CatalogsDocument): Promise<void>;
  /** Writes `catalogs.v1.json` with exactly these bytes, over any older backup. */
  writeBackupV1(text: string): Promise<void>;
}

/** The frozen item versions, content-addressed by the digest (`sha256:<hex>`) of their text. */
export interface CatalogBlobStore {
  /** Makes sure the blob holds exactly this text: left alone when it does, replaced when it holds anything else. */
  put(digest: string, text: string): Promise<void>;
  /** The text, or `undefined` when there is no such blob. */
  get(digest: string): Promise<string | undefined>;
}

/** The SKILL.md files the skills inventory lists, matched the way `GET /v1/skills/file` matches them. */
export interface SkillDirectory {
  list(): Promise<readonly { readonly path: string; readonly name: string }[]>;
}

/** Every server the MCP inventory declares on this machine, with its component record when it has one. */
export interface McpDirectory {
  servers(): Promise<readonly McpSourceServer[]>;
}

/** This daemon's signing identity and the name it gives itself, or `undefined` when it has none. */
export interface CatalogIdentitySource {
  identity(): Promise<DaemonIdentity | undefined>;
  publisherName(): string;
}
