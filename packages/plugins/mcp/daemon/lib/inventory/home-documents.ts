/**
 * The documents of a harness home Runtimes published (`.claude.json`, `settings.json`, `config.toml`), read through
 * Runtimes' bounded reader. MCP never opens a published home itself: a path counts only when it is EXACTLY
 * `<published home>/<one of the three document names>`, so no other file of a home is ever readable; every other
 * path is read as before (`fallback`).
 */
import {
  RUNTIME_HOME_DOCUMENTS,
  type RuntimeHome,
  type RuntimeHomeDocument,
  type RuntimeHomeReader,
  RuntimeHomeUnreadable,
} from '@ferretry/plugin-runtimes/contract';
import { McpDocumentUnreadable, type McpHarnessDocuments } from './service.ts';

/** Larger than any real one: a busy `.claude.json` runs to a few hundred kilobytes (as `RootMcpHarnessDocuments`). */
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

/** What the published homes are, right now. */
export interface PublishedHomes {
  homes(): Promise<readonly RuntimeHome[]>;
  home(id: string): RuntimeHomeReader | undefined;
}

/** Parses a document's text; the half binds JSON and TOML. */
export type HomeDocumentParser = (text: string, format: 'json' | 'toml') => unknown;

const documentNamed = (name: string): RuntimeHomeDocument | undefined =>
  (RUNTIME_HOME_DOCUMENTS as readonly string[]).includes(name) ? (name as RuntimeHomeDocument) : undefined;

export class PublishedHomeDocuments implements McpHarnessDocuments {
  constructor(
    private readonly published: () => PublishedHomes | undefined,
    private readonly parse: HomeDocumentParser,
    private readonly fallback: McpHarnessDocuments,
  ) {}

  async read(path: string, format: 'json' | 'toml'): Promise<unknown> {
    const published = this.published();
    const cut = path.lastIndexOf('/');
    const file = documentNamed(path.slice(cut + 1));
    if (published === undefined || cut < 0 || file === undefined) return await this.fallback.read(path, format);
    const folder = path.slice(0, cut);
    const home = (await published.homes()).find(candidate => candidate.home.replace(/\/+$/u, '') === folder);
    if (home === undefined) return await this.fallback.read(path, format);
    const reader = published.home(home.id);
    if (reader === undefined) throw new McpDocumentUnreadable(`${path} is no longer a published runtime home.`);
    let text: string | null;
    try {
      text = await reader.document(file, MAX_DOCUMENT_BYTES);
    } catch (error) {
      throw new McpDocumentUnreadable(
        error instanceof RuntimeHomeUnreadable ? error.message : `${path} could not be read.`,
      );
    }
    if (text === null || text.trim() === '') return null;
    try {
      return this.parse(text, format);
    } catch {
      // The parser's message can quote the document, which may hold a key: say only what it is.
      throw new McpDocumentUnreadable(
        `${path} is not valid ${format === 'json' ? 'JSON' : 'TOML'}, so its MCP servers cannot be read.`,
      );
    }
  }
}
