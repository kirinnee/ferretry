import type { PluginClient, TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import { EXIT_USAGE } from '../args.ts';
import { AttachTargetSchema } from '../protocol/attach-target.ts';
import type { ITerminalAttacher } from './ports.ts';

const ATTACH_ROUTE = 'GET /v1/ferrets/:ferretId/attach';

/**
 * `fy attach <ferret>`: attach to the terminal a ferret runs in (today's `ReadsController.attach`). Only after both
 * the daemon and this client proved the complete tmux process incarnation; the attacher re-checks it here.
 */
export class AttachController {
  constructor(
    private readonly client: Pick<PluginClient, 'call'>,
    private readonly attacher: ITerminalAttacher,
    private readonly io: TerminalIo,
  ) {}

  async attach(invocation: VerbInvocation): Promise<number> {
    const [ferret] = invocation.args;
    if (ferret === undefined || ferret.trim() === '') {
      this.io.err('attach needs the ferret to attach to\n');
      return EXIT_USAGE;
    }
    try {
      const target = AttachTargetSchema.parse(await this.client.call(ATTACH_ROUTE, { params: { ferretId: ferret } }));
      return await this.attacher.attach(target);
    } catch (error) {
      this.io.err(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
}
