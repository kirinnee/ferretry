import type { ISessionApi, SessionEnvironment } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';
import { buildStartRequest, type StartFlags } from './start-request.ts';

/** `start` flags plus how to print the answer. */
export interface StartCommandFlags extends StartFlags {
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

  async execute(flags: StartCommandFlags): Promise<void> {
    const started = await this.api.start(buildStartRequest(flags, this.environment));
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
