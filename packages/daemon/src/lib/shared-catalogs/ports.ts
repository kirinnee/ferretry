/**
 * What the publisher side needs from the machine. Each is a port: the pure code in this folder never
 * reads a file, asks the inventory, or holds a key (docs/standards/three-layer-architecture).
 */
import type { DaemonIdentity } from '@ferretry/relay';
import type { CatalogsDocument } from './document.ts';
import type { McpSourceServer } from './mcp-source.ts';

/** `state/catalogs/catalogs.json`. A damaged file is an error from `read`, never an empty document. */
export interface CatalogDocumentStore {
  read(): Promise<CatalogsDocument>;
  write(document: CatalogsDocument): Promise<void>;
}

/** The frozen item versions, content-addressed by their digest (`sha256:<hex>`) and never rewritten. */
export interface CatalogBlobStore {
  /** Writes the text unless a blob of that digest is already there. */
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
