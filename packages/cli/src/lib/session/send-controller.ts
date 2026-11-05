import type { SendDisposition, SendRecord, SendRequest, SendResult } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { SessionCommandError } from './errors.ts';
import type { ISessionApi, ISessionFiles, SendWaitClock, SessionEnvironment } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';
import {
  describeFate,
  describePark,
  describeSendResult,
  planSend,
  SETTLED_SEND_FATES,
  type SendFlags,
  waitingInFerretryQueue,
} from './send-plan.ts';

export interface SendCommandFlags extends Omit<SendFlags, 'fileMessage'> {
  /** Path to a file holding the message; its contents follow the typed message. */
  readonly messageFile?: string;
  readonly json?: boolean;
  /** Wait until the daemon proves where the message went: delivered, timed out, or unconfirmed. */
  readonly wait?: boolean;
}

/** How long a `send --wait` waits, and how often it asks. A send to a busy agent may wait longer. */
const WAIT_LIMIT_MS = 5 * 60_000;
const WAIT_INTERVAL_MS = 2_000;

/** Sends a message to a session: `fy send` (and its peer-reply spelling, `fy reply`). */
export class SendMessageController {
  constructor(
    private readonly api: ISessionApi,
    private readonly files: ISessionFiles,
    private readonly presenter: SessionPresenter,
    private readonly environment: SessionEnvironment,
    private readonly clock: SendWaitClock,
  ) {}

  async execute(id: string, flags: SendCommandFlags): Promise<void> {
    const fileMessage = flags.messageFile === undefined ? '' : await this.files.readText(flags.messageFile);
    // Planned — and therefore fully validated — before the first upload: the source uploaded every
    // attachment and only then rejected an illegal `--ask`, orphaning them on the daemon.
    const plan = planSend({ ...flags, fileMessage }, this.environment);

    const attachments = await Promise.all(plan.attachmentPaths.map(path => this.api.upload(id, path)));
    const result = await this.dispatch(id, {
      message: plan.message,
      attachmentIds: attachments.map(attachment => attachment.id),
      now: plan.now,
      ...(plan.replyExpected ? { replyExpected: true } : {}),
      label: plan.label,
    });

    this.presenter.note(describeSendResult(result));
    if (plan.park !== undefined)
      await this.park(plan.park, {
        disposition: result.disposition,
        // The wait is routed by the peer's session id; its callsign is only for the human note.
        peerId: result.config.id,
        peerName: result.config.teammate ?? result.config.id,
      });
    if (flags.wait === true) await this.wait(result);
    this.presenter.view(result, flags.json === true);
  }

  /**
   * Sends the request, and sends it once more WITHOUT its label when an older daemon refuses the field.
   *
   * The wire schema is strict, so a daemon that predates labels answers 400 `invalid_request` for the new
   * field and nothing else: no message was accepted, so sending again cannot make anyone read it twice.
   * The note says the label was lost, because a sender that wrote `--kind fyi` expected it to be held.
   */
  private async dispatch(id: string, request: SendRequest): Promise<SendResult> {
    try {
      return await this.api.send(id, request);
    } catch (error) {
      if (!(error instanceof FyHttpError) || error.status !== 400 || error.code !== 'invalid_request') throw error;
      const { label: _label, ...unlabelled } = request;
      const result = await this.api.send(id, unlabelled);
      this.presenter.note('this daemon does not know --kind; sent as an ordinary message');
      return result;
    }
  }

  /**
   * Polls the send's own ledger row until the daemon has proven where it went.
   *
   * A message PROVEN not delivered fails the command, because sending it again is safe and a script
   * should know to. An UNCONFIRMED one does not: it may have landed, and a script that resent on a
   * non-zero exit would make the agent read it twice.
   */
  private async wait(result: SendResult): Promise<void> {
    const sendId = result.sendId;
    if (sendId === undefined) {
      this.presenter.note('this daemon does not report a send id, so the send cannot be waited on');
      return;
    }
    const deadline = this.clock.nowMs() + WAIT_LIMIT_MS;
    const untyped = waitingInFerretryQueue(result);
    for (;;) {
      const record = await this.status(result.config.id, sendId, untyped);
      if (record === undefined) {
        // Still in Ferretry's queue: the ledger has no row until a key goes to the pane. That is waiting,
        // never "no such send" — and never a failure a script would answer by sending it again.
        if (this.clock.nowMs() >= deadline) {
          this.presenter.note(
            `still not typed into the agent after ${WAIT_LIMIT_MS / 60_000}m: it is waiting in Ferretry's queue (see \`fy queue ${result.config.teammate ?? result.config.id}\`); do not resend`,
          );
          return;
        }
        await this.clock.sleep(WAIT_INTERVAL_MS);
        continue;
      }
      if (SETTLED_SEND_FATES.has(record.fate)) {
        // A cancelled message was not delivered either; it fails the wait as a proven absence does.
        if (record.fate === 'timed_out' || record.fate === 'cancelled')
          throw new SessionCommandError(describeFate(record));
        this.presenter.note(describeFate(record));
        return;
      }
      if (this.clock.nowMs() >= deadline) {
        this.presenter.note(`still ${describeFate(record)} after ${WAIT_LIMIT_MS / 60_000}m of waiting`);
        return;
      }
      await this.clock.sleep(WAIT_INTERVAL_MS);
    }
  }

  /**
   * The send's ledger row, or `undefined` while a message still in Ferretry's queue has none yet.
   */
  private async status(id: string, sendId: string, untyped: boolean): Promise<SendRecord | undefined> {
    try {
      return await this.api.sendStatus(id, sendId);
    } catch (error) {
      if (untyped && error instanceof FyHttpError && error.status === 404) return undefined;
      throw error;
    }
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
    if (decision.parked) {
      try {
        await this.api.signal(park.callerSessionId, 'waiting', undefined, {
          peer: peer.peerId,
          ...(park.until === undefined ? {} : { until: park.until }),
          condition: `a reply from ${peer.peerName}`,
        });
      } catch (error) {
        // THE MESSAGE IS ALREADY DELIVERED, so this must not exit non-zero: a script that retries a
        // failed send would send it twice. The wait is what failed, and saying so is the whole answer.
        this.presenter.note(
          `message sent, but this session could not be parked to wait for ${peer.peerName} ` +
            `(${error instanceof Error ? error.message : String(error)}); do not send it again`,
        );
        return;
      }
    }
    this.presenter.note(decision.note);
  }
}
