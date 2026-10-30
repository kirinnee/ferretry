import { titleFromReferencedBrief } from '../tasks/task-title.ts';
import type { ISessionApi, ISessionFiles, SessionEnvironment } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';
import { buildStartRequest, type StartFlags } from './start-request.ts';

/** `start` flags that need the filesystem before a request can be built. */
export interface StartCommandFlags extends Omit<StartFlags, 'prompt' | 'attachments'> {
  /** The prompt typed as arguments. */
  readonly prompt?: string;
  /** Path to a file holding the prompt; its contents follow the typed prompt. */
  readonly promptFile?: string;
  /** Files to attach to the opening message. */
  readonly filePaths?: readonly string[];
  readonly requestId?: string;
  readonly json?: boolean;
}

/** Starts a session: `fy start`. */
export class StartSessionController {
  constructor(
    private readonly api: ISessionApi,
    private readonly files: ISessionFiles,
    private readonly presenter: SessionPresenter,
    private readonly environment: SessionEnvironment,
    /** The shipped command name, so the follow-up hint names commands that exist. */
    private readonly binaryName: string,
  ) {}

  async execute(flags: StartCommandFlags): Promise<void> {
    const filePrompt = flags.promptFile === undefined ? '' : await this.files.readText(flags.promptFile);
    const prompt = [flags.prompt?.trim() ?? '', filePrompt.trim()].filter(part => part !== '').join('\n\n');
    const attachments = await Promise.all((flags.filePaths ?? []).map(path => this.files.readAttachment(path)));

    const name = flags.name ?? (await titleFromReferencedBrief(prompt, path => this.files.readText(path)));
    const plan = buildStartRequest(
      { ...flags, ...(name === undefined ? {} : { name }), ...(prompt === '' ? {} : { prompt }), attachments },
      this.environment,
    );
    for (const warning of plan.warnings) this.presenter.note(warning);

    const view = await this.api.start(plan.request, flags.requestId);
    this.presenter.view(view, flags.json === true);
    // A launch that outran the request window is not a failure: the session is persisted and the
    // agent keeps coming up, so say where to watch it rather than implying something broke.
    if (view.state.status === 'starting')
      this.presenter.note(
        `note: ${view.config.id} is still launching in the background — watch it with \`${this.binaryName} ps\` or \`${this.binaryName} status ${view.config.id}\``,
      );
  }
}
