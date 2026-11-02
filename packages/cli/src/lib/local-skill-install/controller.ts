import { resolve } from 'node:path';
import { STEP_UP_REQUIRED_CODE, type CatalogInstallTarget } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { ILocalSkillInstallGateway, ILocalSkillInstallOutput, ILocalSkillInstallPrompt } from './ports.ts';
import { renderInstalls, renderPreview } from './render.ts';

export interface LocalSkillInstallDeps {
  readonly gateway: ILocalSkillInstallGateway;
  readonly out: ILocalSkillInstallOutput;
  readonly prompt: ILocalSkillInstallPrompt;
  readonly interactive: boolean;
  readonly cwd: string;
  readonly binaryName: string;
}

export interface LocalSkillInstallOptions {
  readonly from?: string;
  readonly to?: string;
  readonly project?: string;
  readonly harness?: string;
  readonly runtime?: string;
  readonly profile?: string;
  readonly yes?: boolean;
  readonly json?: boolean;
}

/** `--json`: stdout carries exactly one protocol payload; the preview goes to stderr. */
export interface LocalSkillJsonOption {
  readonly json?: boolean;
}

/** A sentence for the person, thrown inside the controller and printed once at its edge. */
class Stop extends Error {}

const JSON_NEEDS_YES =
  '--json is for scripts, so it needs --yes too. To read the review and answer yourself, run this without --json.';

const isYes = (answer: string): boolean => ['y', 'yes'].includes(answer.trim().toLowerCase());

/** `fy skill install --from <skill> --to project|runtime`, `fy skill installs`, `fy skill uninstall <id>`. */
export class LocalSkillInstallController {
  constructor(private readonly deps: LocalSkillInstallDeps) {}

  async install(options: LocalSkillInstallOptions): Promise<void> {
    await this.#guarded(async () => {
      if (options.json === true && options.yes !== true) throw new Stop(JSON_NEEDS_YES);
      const source = this.#source(options);
      const target = this.#target(options);
      const preview = await this.deps.gateway.previewLocalSkillInstall(target.scope, { source, target });
      if (options.json === true) this.deps.out.diagnostic(JSON.stringify({ phase: 'preview', preview }));
      else this.deps.out.report(renderPreview(preview));
      if (!(await this.#confirm(preview.replaces === undefined ? 'Copy this?' : 'Replace your copy?', options.yes)))
        return;
      const installed = await this.deps.gateway.applyLocalSkillInstall(target.scope, { previewId: preview.previewId });
      if (options.json === true) {
        this.deps.out.success(JSON.stringify(installed, null, 2));
        return;
      }
      this.deps.out.success(
        `Copied ${installed.install.name} (${installed.install.installId}) to ${installed.install.destination}.`,
      );
      for (const note of installed.notes) this.deps.out.report(note);
    });
  }

  async installs(options: LocalSkillJsonOption = {}): Promise<void> {
    await this.#guarded(async () => {
      const list = await this.deps.gateway.localSkillInstalls();
      if (options.json === true) this.deps.out.success(JSON.stringify(list, null, 2));
      else this.deps.out.report(renderInstalls(list.installs));
    });
  }

  async uninstall(installId: string, options: { readonly yes?: boolean } & LocalSkillJsonOption): Promise<void> {
    await this.#guarded(async () => {
      if (options.json === true && options.yes !== true) throw new Stop(JSON_NEEDS_YES);
      const found = (await this.deps.gateway.localSkillInstalls()).installs.find(
        install => install.installId === installId,
      );
      if (found === undefined)
        throw new Stop(`No copy ${installId}. List them with: ${this.deps.binaryName} skill installs`);
      if (!(await this.#confirm(`Remove ${found.name} from ${found.destination}?`, options.yes))) return;
      const removed = await this.deps.gateway.removeLocalSkillInstall(found.target.scope, installId);
      this.deps.out.success(
        options.json === true
          ? JSON.stringify(removed, null, 2)
          : `Removed ${removed.name} from ${removed.destination}.`,
      );
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

  /** A skill folder or its SKILL.md; the daemon looks the SKILL.md up in its inventory. */
  #source(options: LocalSkillInstallOptions): { path: string } {
    if (options.from === undefined || options.from === '')
      throw new Stop('Name the skill to copy: --from <skill folder or SKILL.md>.');
    const path = resolve(this.deps.cwd, options.from);
    return { path: path.endsWith('/SKILL.md') ? path : `${path}/SKILL.md` };
  }

  #target(options: LocalSkillInstallOptions): CatalogInstallTarget {
    if (options.to !== 'project' && options.to !== 'runtime')
      throw new Stop('Say where it goes: --to project (with --project <root> --harness claude|codex) or --to runtime.');
    if (options.to === 'project') {
      if (options.project === undefined) throw new Stop('A project copy needs --project <root>.');
      if (options.harness !== 'claude' && options.harness !== 'codex')
        throw new Stop('A project copy needs --harness claude or --harness codex.');
      return { scope: 'project', projectRoot: resolve(this.deps.cwd, options.project), harness: options.harness };
    }
    if (options.runtime === undefined || options.profile === undefined)
      throw new Stop('A runtime copy needs --runtime <name> and --profile <name>.');
    return { scope: 'runtime', runtime: options.runtime, profile: options.profile };
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
