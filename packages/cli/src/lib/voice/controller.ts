import type { VoiceEngineView, VoiceInstallProgress } from '@ferretry/protocol';
import type { IVoiceClock, IVoiceGateway, IVoiceOutput } from './ports.ts';
import { progressLine, renderStatus } from './render.ts';

/** Options every voice command accepts. */
export interface VoiceCommandOptions {
  readonly json?: boolean;
}

/** How often `fy voice install` asks the daemon how far it is. */
const INSTALL_POLL_MS = 1_000;

/** Print a download line at most this often (in percent), so a log does not fill with one line per second. */
const PERCENT_STEP = 5;

/**
 * Drives `fy voice …`.
 *
 * The speech engine lives in the daemon; this group asks it to install, cancel, remove and choose models and
 * reads back how it is. `install` answers once the daemon has STARTED the download and then follows it, so
 * the command can end with the install, but ending the command (Ctrl-C) does not stop the download —
 * `fy voice cancel` does.
 */
export class VoiceController {
  constructor(
    private readonly gateway: IVoiceGateway,
    private readonly out: IVoiceOutput,
    private readonly clock: IVoiceClock,
    private readonly bin: string,
  ) {}

  async status(options: VoiceCommandOptions): Promise<void> {
    this.#show(await this.gateway.status(), options);
  }

  async install(id: string, options: VoiceCommandOptions): Promise<void> {
    let view = await this.gateway.install(id);
    if (options.json !== true) {
      this.out.report(
        `Installing ${id}. It keeps going if you stop this command; "${this.bin} voice cancel" stops it.`,
      );
    }
    let lastLine = '';
    let lastPercent = -PERCENT_STEP;
    for (;;) {
      const progress = view.install;
      if (progress === null || progress.modelId !== id) break;
      if (options.json !== true) {
        const percent = this.#percent(progress);
        const line = progressLine(progress);
        const fresh = percent === undefined ? line !== lastLine : percent - lastPercent >= PERCENT_STEP;
        if (fresh) {
          this.out.report(line);
          lastLine = line;
          if (percent !== undefined) lastPercent = percent;
        }
      }
      if (progress.status !== 'running') break;
      await this.clock.sleep(INSTALL_POLL_MS);
      view = await this.gateway.status();
    }
    const ended = view.install;
    if (options.json === true) this.out.report(JSON.stringify(view, null, 2));
    else if (ended?.status === 'succeeded')
      this.out.success(`${id} is installed. Use it with: ${this.bin} voice use ${id}`);
    if (ended !== null && ended.modelId === id && ended.status !== 'succeeded') {
      if (options.json !== true) this.out.warn(progressLine(ended));
      this.out.setExitCode(1);
    }
  }

  async cancel(options: VoiceCommandOptions): Promise<void> {
    const view = await this.gateway.cancel();
    if (options.json === true) this.out.report(JSON.stringify(view, null, 2));
    else this.out.success(view.install === null ? 'Nothing was installing.' : progressLine(view.install));
  }

  async remove(id: string, options: VoiceCommandOptions): Promise<void> {
    const view = await this.gateway.remove(id);
    if (options.json === true) this.out.report(JSON.stringify(view, null, 2));
    else this.out.success(`${id} is removed (its files and any part-downloaded archive).`);
  }

  async use(id: string, options: VoiceCommandOptions): Promise<void> {
    const view = await this.gateway.use(id);
    if (options.json === true) this.out.report(JSON.stringify(view, null, 2));
    else this.out.success(`${id} is now the active ${view.models.find(entry => entry.id === id)?.role ?? ''} model.`);
  }

  #percent(progress: VoiceInstallProgress): number | undefined {
    if (progress.phase !== 'downloading' || progress.bytesTotal === 0) return undefined;
    return Math.floor((progress.bytesDone / progress.bytesTotal) * 100);
  }

  #show(view: VoiceEngineView, options: VoiceCommandOptions): void {
    this.out.report(options.json === true ? JSON.stringify(view, null, 2) : renderStatus(view));
  }
}
