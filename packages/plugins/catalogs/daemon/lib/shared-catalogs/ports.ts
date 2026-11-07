/**
 * What the publisher side needs from the machine. Each is a port: the pure code in this folder never
 * reads a file, asks the inventory, or holds a key (docs/standards/three-layer-architecture).
 */
import type { CatalogSigningIdentity } from '../relay-wire/index.ts';
import type { CatalogsDocument } from './document.ts';
import type { McpSourceServer } from './mcp-source.ts';

/**
 * What `state/catalogs/catalogs.json` holds.
 */
export interface CatalogDocumentStore {
  read(): Promise<CatalogsDocument | undefined>;
  write(document: CatalogsDocument): Promise<void>;
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

/** The links serving a version: pending, live or ending (docs/catalogs.md § Links). A retired version may serve none. */
export interface LinkServing {
  readonly linkId: string;
  readonly itemId: string;
  readonly version: number;
}

/** Which links serve which versions, read from the links file by the program that owns it. */
export interface LinkUsage {
  serving(): Promise<readonly LinkServing[]>;
}

/** This daemon's signing identity and the name it gives itself, or `undefined` when it has none. */
export interface CatalogIdentitySource {
  identity(): Promise<CatalogSigningIdentity | undefined>;
  publisherName(): string;
}
