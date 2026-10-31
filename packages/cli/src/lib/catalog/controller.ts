import { resolve } from 'node:path';
import type { CatalogItemSource, OwnedCatalog } from '@ferretry/protocol';
import type { ICatalogFileWriter, ICatalogGateway, ICatalogOutput, ICatalogPrompt } from './ports.ts';
import {
  renderCatalogCreated,
  renderCatalogDeleted,
  renderCatalogList,
  renderCatalogUpdated,
  renderExported,
  renderPreview,
  renderPublished,
  renderWithdrawn,
} from './render.ts';
import { catalogFileSlug, resolveCatalog, resolveItem } from './resolve.ts';

export interface CatalogCommandOptions {
  readonly json?: boolean;
}

/** Commands that change something ask first, unless `--yes` said so already. */
export interface CatalogConfirmedOptions extends CatalogCommandOptions {
  readonly yes?: boolean;
}

export interface CatalogCreateOptions extends CatalogCommandOptions {
  readonly description?: string;
}

export interface CatalogAddOptions extends CatalogConfirmedOptions {
  readonly skill?: string;
  readonly mcp?: string;
  readonly summary?: string;
}

export interface CatalogExportOptions extends CatalogCommandOptions {
  readonly item?: readonly string[];
  readonly out?: string;
  readonly force?: boolean;
}

/** What a typed answer must be to count as yes. */
const AFFIRMATIVE = /^y(?:es)?$/iu;

/**
 * Drives `fy catalog …` on the publisher's side: make catalogs, freeze skills and MCP setups into them,
 * and export a signed file. Installing one is a different machine's job and a different command group.
 *
 * Adding and publishing print the WHOLE review before asking, and send the digest of what was printed
 * back with the write — so what the person read is what the daemon freezes.
 */
export class CatalogController {
  constructor(
    private readonly gateway: ICatalogGateway,
    private readonly out: ICatalogOutput,
    private readonly prompt: ICatalogPrompt,
    private readonly files: ICatalogFileWriter,
    private readonly interactive: boolean,
    /** Where this invocation is standing: an export lands here unless `--out` says otherwise. */
    private readonly cwd: string,
  ) {}

  async list(options: CatalogCommandOptions): Promise<void> {
    const list = await this.gateway.list();
    this.#report(list, options, () => renderCatalogList(list));
  }

  async create(name: string, options: CatalogCreateOptions): Promise<void> {
    const created = await this.gateway.create({
      name: name.trim(),
      ...(options.description === undefined ? {} : { description: options.description }),
    });
    this.#report(created, options, () => renderCatalogCreated(created));
  }

  async rename(catalog: string, name: string, options: CatalogCommandOptions): Promise<void> {
    const found = await this.#catalog(catalog);
    const updated = await this.gateway.update(found.id, { name: name.trim() });
    this.#report(updated, options, () => renderCatalogUpdated(updated));
  }

  async describe(catalog: string, description: string, options: CatalogCommandOptions): Promise<void> {
    const found = await this.#catalog(catalog);
    const updated = await this.gateway.update(found.id, { description });
    this.#report(updated, options, () => renderCatalogUpdated(updated));
  }

  async remove(catalog: string, options: CatalogConfirmedOptions): Promise<void> {
    const found = await this.#catalog(catalog);
    await this.#confirm(
      `Delete catalog ${found.name} (${found.id}) and every version in it? This cannot be undone.`,
      options,
    );
    const deleted = await this.gateway.remove(found.id);
    this.#report(deleted, options, () => renderCatalogDeleted(found.name, deleted.catalogId));
  }

  /** Previews the source, shows it in full, and freezes it as version 1 only if the person says yes. */
  async add(catalog: string, options: CatalogAddOptions): Promise<void> {
    const source = requestedSource(options);
    const found = await this.#catalog(catalog);
    const summary = options.summary === undefined ? {} : { summary: options.summary };
    const preview = await this.gateway.preview(found.id, { source, ...summary });
    this.#showPreview(preview, options);
    await this.#confirm(`Add ${preview.kind} ${preview.name} to ${found.name} exactly as shown above?`, options);
    const published = await this.gateway.add(found.id, { source, digest: preview.digest, ...summary });
    this.#report(published, options, () => renderPublished(published));
  }

  /** Previews the next version of an item from the source it remembers, and publishes it if the person says yes. */
  async publish(catalog: string, item: string, options: CatalogConfirmedOptions): Promise<void> {
    const found = await this.#catalog(catalog);
    const target = resolveItem(found, item);
    if (target.withdrawnAt !== undefined) throw new Error(`${target.name} was withdrawn and cannot get a new version`);
    const preview = await this.gateway.preview(found.id, { itemId: target.itemId });
    if (preview.sameAsVersion !== undefined) {
      this.out.success(
        `${target.name} has not changed since version ${preview.sameAsVersion}; there is nothing to publish.`,
      );
      return;
    }
    this.#showPreview(preview, options);
    await this.#confirm(`Publish version ${preview.version} of ${target.name} exactly as shown above?`, options);
    const published = await this.gateway.publishVersion(found.id, target.itemId, { digest: preview.digest });
    this.#report(published, options, () => renderPublished(published));
  }

  async withdraw(catalog: string, item: string, options: CatalogConfirmedOptions): Promise<void> {
    const found = await this.#catalog(catalog);
    const target = resolveItem(found, item);
    await this.#confirm(
      `Withdraw ${target.name} (${target.itemId}) from ${found.name}? Installers are told it is gone.`,
      options,
    );
    const withdrawn = await this.gateway.withdraw(found.id, target.itemId);
    this.#report(withdrawn, options, () => renderWithdrawn(withdrawn, target.name));
  }

  /**
   * Writes the signed catalog file. It refuses to replace a file that is there unless `--force`, and says
   * so BEFORE asking the daemon to sign anything.
   */
  async export(catalog: string, options: CatalogExportOptions): Promise<void> {
    const found = await this.#catalog(catalog);
    const path = resolve(this.cwd, options.out ?? `${catalogFileSlug(found.name)}.catalog.json`);
    const overwrite = options.force === true;
    if (!overwrite && (await this.files.exists(path))) {
      throw new Error(`${path} already exists — pass --force to replace it, or --out to write somewhere else`);
    }
    const itemIds = (options.item ?? []).map(wanted => resolveItem(found, wanted).itemId);
    const file = await this.gateway.export(found.id, itemIds.length === 0 ? {} : { itemIds });
    await this.files.write(path, `${JSON.stringify(file, null, 2)}\n`, overwrite);
    this.#report({ path, file }, options, () => renderExported(found.name, file.items.length, path));
  }

  async #catalog(wanted: string): Promise<OwnedCatalog> {
    return resolveCatalog((await this.gateway.list()).catalogs, wanted);
  }

  /** The preview in full. With `--json` it goes to stderr, so stdout stays one final payload. */
  #showPreview(preview: Parameters<typeof renderPreview>[0], options: CatalogCommandOptions): void {
    if (options.json === true) this.out.diagnostic(JSON.stringify({ phase: 'preview', preview }));
    else this.out.success(renderPreview(preview));
  }

  /**
   * A typed y/N, unless `--yes` waived it. Off a terminal there is nobody to answer, so an unattended
   * run must say `--yes` rather than have the review silently skipped.
   */
  async #confirm(question: string, options: CatalogConfirmedOptions): Promise<void> {
    if (options.yes === true) return;
    if (!this.interactive) throw new Error('nobody to ask on this terminal — pass --yes to go ahead');
    const answer = await this.prompt.ask(`${question} [y/N]`);
    if (!AFFIRMATIVE.test(answer.trim())) throw new Error('cancelled — nothing was changed');
  }

  #report(payload: unknown, options: CatalogCommandOptions, human: () => string): void {
    this.out.success(options.json === true ? JSON.stringify(payload, null, 2) : human());
  }
}

/** Exactly one of `--skill` and `--mcp`, so a request never guesses what the person meant. */
function requestedSource(options: CatalogAddOptions): CatalogItemSource {
  if (options.skill !== undefined && options.mcp !== undefined) throw new Error('pass only one of --skill, --mcp');
  if (options.skill !== undefined) return { kind: 'skill', skill: options.skill };
  if (options.mcp !== undefined) return { kind: 'mcp', mcp: options.mcp };
  throw new Error('say what to add: --skill <SKILL.md path or name> or --mcp <inventory id or name>');
}
