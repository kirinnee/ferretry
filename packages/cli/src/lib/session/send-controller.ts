import type { SendDisposition } from '@ferretry/protocol';
import type { ISessionApi, ISessionFiles, SessionEnvironment } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';
import { describeDisposition, describePark, planSend, type SendFlags } from './send-plan.ts';

export interface SendCommandFlags extends Omit<SendFlags, 'fileMessage'> {
  /** Path to a file holding the message; its contents follow the typed message. */
  readonly messageFile?: string;
  readonly json?: boolean;
}

/** Sends a message to a session: `fy send` (and its peer-reply spelling, `fy reply`). */
export class SendMessageController {
  constructor(
    private readonly api: ISessionApi,
    private readonly files: ISessionFiles,
    private readonly presenter: SessionPresenter,
    private readonly environment: SessionEnvironment,
  ) {}

  async execute(id: string, flags: SendCommandFlags): Promise<void> {
    const fileMessage = flags.messageFile === undefined ? '' : await this.files.readText(flags.messageFile);
    // Planned — and therefore fully validated — before the first upload: the source uploaded every
    // attachment and only then rejected an illegal `--ask`, orphaning them on the daemon.
    const plan = planSend({ ...flags, fileMessage }, this.environment);

    const attachments = await Promise.all(plan.attachmentPaths.map(path => this.api.upload(id, path)));
    const result = await this.api.send(id, {
      message: plan.message,
      attachmentIds: attachments.map(attachment => attachment.id),
      now: plan.now,
      ...(plan.replyExpected ? { replyExpected: true } : {}),
    });

    this.presenter.note(describeDisposition(result.disposition));
    if (plan.park !== undefined)
      await this.park(plan.park, {
        disposition: result.disposition,
        // The wait is routed by the peer's session id; its callsign is only for the human note.
        peerId: result.config.id,
        peerName: result.config.teammate ?? result.config.id,
      });
    this.presenter.view(result, flags.json === true);
  }

  /**
   * Parks the caller until the peer replies.
   *
   * Declared after the send lands, so a failed send never leaves this session waiting on a message
   * the peer was never given.
   */
  private async park(
    park: { callerSessionId: string; until?: string },
    peer: { disposition: SendDisposition; peerId: string; peerName: string },
  ): Promise<void> {
    const decision = describePark({
      disposition: peer.disposition,
      peer: peer.peerName,
      ...(park.until === undefined ? {} : { until: park.until }),
    });
    if (decision.parked)
      await this.api.signal(park.callerSessionId, 'waiting', undefined, {
        peer: peer.peerId,
        ...(park.until === undefined ? {} : { until: park.until }),
        condition: `a reply from ${peer.peerName}`,
      });
    this.presenter.note(decision.note);
  }
}
