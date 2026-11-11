import { SessionCommandError } from './errors.ts';
import type { ISessionApi, SessionEnvironment } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';
import { COMMON_SCRATCH_ROOTS, isScratchPath, SCRATCH_REMEDY, scratchMessage } from './scratch.ts';
import { buildStartRequest, folderOf, type StartFlags, startWarnings } from './start-request.ts';

/**
 * Where a helper (`fy new`) runs. Present only for `new`; `fy start` has no guard and no parent lookup.
 */
export interface NewFolderPolicy {
  /** The ferret that typed the command (the shell's FY_SESSION_ID): its folder is the default. */
  readonly callerId?: string;
  /** `--allow-scratch`: a named temporary folder is meant. */
  readonly allowScratch: boolean;
  /** This machine's own temporary folders (the shell's `TMPDIR`, the OS temp folder), added to the common roots. */
  readonly tmpRoots?: readonly string[];
}

/** `start` flags plus how to print the answer. */
export interface StartCommandFlags extends StartFlags {
  readonly newFolder?: NewFolderPolicy;
  /** `--request-id`: the idempotency key; a start retried with the same key answers the ferret it already started. */
  readonly requestId?: string;
  readonly json?: boolean;
}

/** Starts a ferret: `fy start`. */
export class StartSessionController {
  constructor(
    private readonly api: ISessionApi,
    private readonly presenter: SessionPresenter,
    private readonly environment: SessionEnvironment,
    /** The shipped command name, so the follow-up hint names commands that exist. */
    private readonly binaryName: string,
  ) {}

  /**
   * The folder a helper starts in. A typed `--cwd`, or a person's own shell folder, is NAMED and refused when it is
   * temporary unless `--allow-scratch`. A ferret's helper with no `--cwd` runs in the PARENT's folder (read from its
   * record), never refused even when temporary; if that read fails the start is refused, never run in the shell's folder.
   */
  private async helperFolder(typed: string | undefined, policy: NewFolderPolicy): Promise<string | undefined> {
    const named = typed?.trim() ?? '';
    if (named === '' && policy.callerId !== undefined) {
      try {
        return (await this.api.get(policy.callerId)).folder;
      } catch {
        throw new SessionCommandError(
          `could not read the folder of ${policy.callerId}, the ferret running this command; name the folder with --cwd <folder>`,
        );
      }
    }
    const folder = folderOf(named, this.environment.cwd);
    const roots = [...COMMON_SCRATCH_ROOTS, ...(policy.tmpRoots ?? [])];
    if (folder !== undefined && !policy.allowScratch && isScratchPath(folder, roots))
      throw new SessionCommandError(`${scratchMessage(folder)} ${SCRATCH_REMEDY}`);
    return folder;
  }

  async execute(flags: StartCommandFlags): Promise<void> {
    const cwd = flags.newFolder === undefined ? flags.cwd : await this.helperFolder(flags.cwd, flags.newFolder);
    const body = buildStartRequest({ ...flags, ...(cwd === undefined ? {} : { cwd }) }, this.environment);
    for (const warning of startWarnings(flags)) this.presenter.note(warning);
    const started = await this.api.start(body, flags.requestId);
    const view = await this.api.get(started.id);
    this.presenter.view(view, flags.json === true);
    // A launch that outran the request is not a failure: the ferret is recorded and keeps coming up, so say where to
    // watch it rather than implying something broke.
    if (view.state === 'starting')
      this.presenter.note(
        `note: ${view.id} is still starting — watch it with \`${this.binaryName} ps\` or \`${this.binaryName} status ${view.id}\``,
      );
  }
}
