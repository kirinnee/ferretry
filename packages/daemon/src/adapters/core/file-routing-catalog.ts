import {
  parseRoutingCatalog,
  type FileSystemPort,
  type RoutingCatalog,
  type RoutingCatalogPort,
} from '../../lib/index.ts';

/**
 * The routing catalog, read from the operator's configuration document.
 *
 * There is no built-in default and there must not be one: the catalog IS the routing doctrine — its
 * floors decide what may lead critical work, and its per-account options decide who may serve it —
 * so a daemon that invented one would be the fourth hardcoded fleet table this port exists to
 * delete. An absent or malformed catalog therefore refuses to answer, naming the file to write.
 */
export class FileRoutingCatalog implements RoutingCatalogPort {
  constructor(
    private readonly files: FileSystemPort,
    private readonly catalogPath: string,
  ) {}

  async catalog(): Promise<RoutingCatalog> {
    const text = await this.files.readText(this.catalogPath);
    if (text === undefined)
      throw new Error(`no routing catalog at ${this.catalogPath} — write one to enable recommendations`);
    return parseRoutingCatalog(JSON.parse(text));
  }
}
