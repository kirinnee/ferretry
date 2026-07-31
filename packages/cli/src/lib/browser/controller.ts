import { BrowserActionResultSchema, BrowserStatusSchema } from '@ferretry/protocol';
import { BrowserLoginStatusSchema, renderLoginStatus } from './login.ts';
import { renderBrowserAction, renderBrowserStatus, screenshotPayload } from './render.ts';
import { browserRequest } from './request.ts';
import type { BrowserCommand, BrowserRequest, IBrowserGateway, IBrowserIo, IScreenshotWriter } from './types.ts';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const jsonInit = (request: BrowserRequest): RequestInit =>
  request.body === undefined
    ? { method: request.method }
    : { method: request.method, body: JSON.stringify(request.body), headers: { 'content-type': 'application/json' } };

/** Environment facts the controller is told rather than reads. */
export interface BrowserContext {
  /** The session this CLI runs inside; used when `--session` was not given. */
  readonly selfSessionId?: string;
}

/** What the command surface needs from the controller. */
export interface IBrowserRunner {
  run(command: BrowserCommand): Promise<number>;
}

/**
 * One controller for the whole `browser` group. Every response is parsed against a schema before a
 * single field is read, so a daemon that answers with the wrong shape is reported rather than
 * rendered as `undefined`.
 */
export class BrowserController implements IBrowserRunner {
  constructor(
    private readonly gateway: IBrowserGateway,
    private readonly io: IBrowserIo,
    private readonly screenshots: IScreenshotWriter,
    private readonly context: BrowserContext,
  ) {}

  async run(command: BrowserCommand): Promise<number> {
    try {
      this.io.success(await this.#execute(command));
      return 0;
    } catch (error) {
      this.io.error(errorText(error));
      this.io.setExitCode(1);
      return 1;
    }
  }

  async #execute(command: BrowserCommand): Promise<string> {
    const request = browserRequest(command, this.context.selfSessionId);
    const init = jsonInit(request);

    if (command.command === 'login') {
      return renderLoginStatus(await this.gateway.request(request.path, BrowserLoginStatusSchema, init));
    }
    if (command.command === 'status') {
      return renderBrowserStatus(await this.gateway.request(request.path, BrowserStatusSchema, init));
    }

    const result = await this.gateway.request(request.path, BrowserActionResultSchema, init);
    if (command.command === 'screenshot') {
      // kteam printed nothing at all here, so a successful capture looked like a silent no-op.
      await this.screenshots.write(command.output, screenshotPayload(result));
      return `screenshot written to ${command.output}`;
    }
    return renderBrowserAction(result, command.command === 'read');
  }
}
