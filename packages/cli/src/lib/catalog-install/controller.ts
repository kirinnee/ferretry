import { resolve } from 'node:path';
import {
  readSharedCatalogFile,
  SHARED_CATALOG_FILE_MAX_BYTES,
  STEP_UP_REQUIRED_CODE,
  type CatalogInstallPreview,
  type CatalogInstallTarget,
  type CatalogSecretBindings,
  type SharedCatalogItem,
  type SignedCatalogManifest,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type {
  ICatalogFileReader,
  ICatalogInstallGateway,
  ICatalogInstallOutput,
  ICatalogInstallPrompt,
} from './ports.ts';
import { renderInstalls, renderPreview } from './render.ts';

export interface CatalogInstallDeps {
  readonly gateway: ICatalogInstallGateway;
  readonly files: ICatalogFileReader;
  readonly out: ICatalogInstallOutput;
  readonly prompt: ICatalogInstallPrompt;
  readonly interactive: boolean;
  readonly cwd: string;
  readonly binaryName: string;
}

export interface CatalogInstallOptions {
  readonly item?: string;
  readonly project?: string;
  readonly harness?: string;
  readonly runtime?: string;
  readonly profile?: string;
  readonly bind: readonly string[];
  readonly unbound: readonly string[];
  readonly older?: boolean;
  readonly yes?: boolean;
}

/** A sentence for the person, thrown inside the controller and printed once at its edge. */
class Stop extends Error {}

const isYes = (answer: string): boolean => ['y', 'yes'].includes(answer.trim().toLowerCase());

/** `fy catalog install <file>`, `fy catalog installs`, `fy catalog uninstall <id>` (docs/catalogs.md § Installing). */
export class CatalogInstallController {
  constructor(private readonly deps: CatalogInstallDeps) {}

  async install(path: string, options: CatalogInstallOptions): Promise<void> {
    await this.#guarded(async () => {
      const target = this.#target(options);
      const bindFlags = this.#bindFlags(options);
      const item = await this.#readItem(path, options.item);
      const preview = await this.deps.gateway.previewCatalogInstall(target.scope, {
        signedManifest: item.signedManifest,
        item: item.item,
        target,
        ...(options.older === true ? { allowOlder: true as const } : {}),
      });
      this.deps.out.report(renderPreview(preview));
      const secretBindings = await this.#bindings(preview, bindFlags);
      if (
        !(await this.#confirm(
          preview.replaces === undefined ? 'Install this?' : 'Replace the installed copy?',
          options.yes,
        ))
      )
        return;
      const installed = await this.deps.gateway.applyCatalogInstall(target.scope, {
        previewId: preview.previewId,
        secretBindings,
      });
      this.deps.out.success(
        `Installed ${installed.install.provenance.name} (${installed.install.installId}) in ${installed.install.destination}.`,
      );
      for (const note of installed.notes) this.deps.out.report(note);
    });
  }

  async installs(): Promise<void> {
    await this.#guarded(async () => {
      this.deps.out.report(renderInstalls((await this.deps.gateway.catalogInstalls()).installs));
    });
  }

  async uninstall(installId: string, options: { readonly yes?: boolean }): Promise<void> {
    await this.#guarded(async () => {
      const found = (await this.deps.gateway.catalogInstalls()).installs.find(
        install => install.installId === installId,
      );
      if (found === undefined)
        throw new Stop(`No install ${installId}. List them with: ${this.deps.binaryName} catalog installs`);
      if (!(await this.#confirm(`Remove ${found.provenance.name} from ${found.destination}?`, options.yes))) return;
      const removed = await this.deps.gateway.removeCatalogInstall(found.target.scope, installId);
      this.deps.out.success(`Removed ${removed.provenance.name} from ${removed.destination}.`);
    });
  }

  async #guarded(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (error instanceof Stop) this.#fail(error.message);
      else if (error instanceof FyHttpError && error.code === STEP_UP_REQUIRED_CODE)
        this.#fail(
          'Nothing was changed. This daemon wants the owner to confirm with a passkey. Confirm in the Ferretry app, then run this again.',
        );
      else if (error instanceof FyHttpError) this.#fail(`Nothing was changed. ${error.message}`);
      else throw error;
    }
  }

  #fail(message: string): void {
    this.deps.out.error(message);
    this.deps.out.setExitCode(1);
  }

  #target(options: CatalogInstallOptions): CatalogInstallTarget {
    const project = options.project !== undefined;
    const runtime = options.runtime !== undefined;
    if (project === runtime)
      throw new Stop(
        'Name where it goes: either --project <root> --harness claude|codex, or --runtime <name> --profile <name>.',
      );
    if (project) {
      if (options.harness !== 'claude' && options.harness !== 'codex')
        throw new Stop('A project install needs --harness claude or --harness codex.');
      return { scope: 'project', projectRoot: resolve(this.deps.cwd, options.project ?? ''), harness: options.harness };
    }
    if (options.profile === undefined) throw new Stop('A runtime install needs --profile <name>.');
    return { scope: 'runtime', runtime: options.runtime ?? '', profile: options.profile };
  }

  #bindFlags(options: CatalogInstallOptions): Map<string, string | null> {
    const flags = new Map<string, string | null>();
    for (const entry of options.bind) {
      const at = entry.indexOf('=');
      if (at < 1 || at === entry.length - 1) throw new Stop(`--bind needs PLACEHOLDER=MY_SECRET, not "${entry}".`);
      this.#set(flags, entry.slice(0, at), entry.slice(at + 1));
    }
    for (const placeholder of options.unbound) this.#set(flags, placeholder, null);
    return flags;
  }

  #set(flags: Map<string, string | null>, placeholder: string, own: string | null): void {
    if (flags.has(placeholder))
      throw new Stop(`${placeholder} is named twice. Give each placeholder one --bind or one --unbound.`);
    flags.set(placeholder, own);
  }

  async #readItem(
    path: string,
    wanted: string | undefined,
  ): Promise<{ signedManifest: SignedCatalogManifest; item: SharedCatalogItem }> {
    const size = await this.deps.files.size(path).catch((error: unknown) => {
      throw new Stop(`Cannot read ${path}: ${(error as Error).message}`);
    });
    if (size > SHARED_CATALOG_FILE_MAX_BYTES)
      throw new Stop('This catalog file is larger than 32 MiB, so it was not read.');
    const text = await this.deps.files.read(path).catch((error: unknown) => {
      throw new Stop(`Cannot read ${path}: ${(error as Error).message}`);
    });
    const reading = readSharedCatalogFile(text);
    if (!reading.ok) throw new Stop(reading.reason);
    const { items, signedManifest } = reading.file;
    const names = items.map(item => item.name);
    const matches = wanted === undefined ? items : items.filter(item => item.name === wanted);
    if (matches.length === 0)
      throw new Stop(
        items.length === 0
          ? 'This file carries no items.'
          : `No item called ${wanted ?? ''} in this file. It carries: ${names.join(', ')}.`,
      );
    const [item] = matches;
    if (matches.length > 1 || item === undefined)
      throw new Stop(`This file carries several items: ${names.join(', ')}. Choose one with --item <name>.`);
    return { signedManifest, item };
  }

  async #bindings(preview: CatalogInstallPreview, flags: Map<string, string | null>): Promise<CatalogSecretBindings> {
    const asked = new Set(preview.secrets.map(secret => secret.placeholder));
    for (const placeholder of flags.keys())
      if (!asked.has(placeholder)) throw new Stop(`This item does not ask for ${placeholder}.`);
    const bindings: Record<string, string | null> = {};
    for (const secret of preview.secrets) {
      const given = flags.get(secret.placeholder);
      if (given !== undefined) {
        bindings[secret.placeholder] = given;
        continue;
      }
      if (!this.deps.interactive)
        throw new Stop(
          `${secret.placeholder} needs an answer: --bind ${secret.placeholder}=<your secret> or --unbound ${secret.placeholder}.`,
        );
      const answer = (
        await this.deps.prompt.ask(
          `Which of your secrets fills ${secret.placeholder}? (a secret name, or empty to leave it unbound)`,
        )
      ).trim();
      bindings[secret.placeholder] = answer === '' ? null : answer;
    }
    return bindings;
  }

  async #confirm(question: string, yes: boolean | undefined): Promise<boolean> {
    const { out } = this.deps;
    if (yes === true) return true;
    if (!this.deps.interactive) {
      out.error('Nothing was changed: this needs a yes. Re-run with --yes to go ahead without being asked.');
      out.setExitCode(1);
      return false;
    }
    if (isYes(await this.deps.prompt.ask(`${question} [y/N]`))) return true;
    out.warn('Nothing was changed.');
    out.setExitCode(1);
    return false;
  }
}
