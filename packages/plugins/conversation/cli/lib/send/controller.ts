import type { SendRecord, SendResult } from '../../../contract/index.ts';
import { CommandError } from '../errors.ts';
import {
  describeFate,
  describePark,
  describeSendResult,
  planSend,
  SETTLED_SEND_FATES,
  type SendFlags,
} from './plan.ts';
import type { ConversationOutput, SendEnvironment, SendFiles, SendGateway } from './ports.ts';

export interface SendCommandFlags extends Omit<SendFlags, 'fileMessage'> {
  /** Path to a file holding the message; its contents follow the typed message. */
  readonly messageFile?: string;
  readonly json?: boolean;
  /** Wait until the daemon proves where the message went: delivered, timed out, or unconfirmed. */
  readonly wait?: boolean;
}

/** How a `send --wait` waits: rounds of a status read the daemon holds open, ten at most (5 minutes at the longest). */
export const WAIT_ROUND_MS = 30_000;
const WAIT_ROUNDS = 10;

/** Sends a message to a ferret: `fy send` (and its peer-reply spelling, `fy reply`). */
export class SendMessageController {
  constructor(
    private readonly gateway: SendGateway,
    private readonly files: SendFiles,
    private readonly output: ConversationOutput,
    private readonly environment: SendEnvironment,
  ) {}

  async execute(ferret: string, flags: SendCommandFlags): Promise<void> {
    const fileMessage = flags.messageFile === undefined ? '' : await this.files.readText(flags.messageFile);
    // Planned — and therefore fully validated — before the first upload: an illegal `--ask` must not leave
    // attachments orphaned on the daemon.
    const plan = planSend({ ...flags, fileMessage }, this.environment);

    const attachments = await Promise.all(plan.attachmentPaths.map(path => this.gateway.upload(ferret, path)));
    const result = await this.gateway.send(ferret, {
      message: plan.message,
      attachmentIds: attachments.map(attachment => attachment.id),
      now: plan.now,
      ...(plan.replyExpected ? { replyExpected: true } : {}),
      label: plan.label,
    });

    this.output.note(describeSendResult(result));
    if (plan.park !== undefined)
      await this.park(plan.park, { disposition: result.disposition, peerId: result.ferret, peerName: ferret });
    if (flags.wait === true) await this.wait(result, ferret);
    this.output.out(flags.json === true ? JSON.stringify(result, null, 2) : `${ferret}: ${result.disposition}`);
  }

  /**
   * Polls the send's own ledger row until the daemon has proven where it went.
   *
   * A message PROVEN not delivered fails the command, because sending it again is safe and a script should know to.
   * An UNCONFIRMED one does not: it may have landed, and a script that resent on a non-zero exit would make the
   * agent read it twice.
   */
  private async wait(result: SendResult, reference: string): Promise<void> {
    const sendId = result.sendId;
    if (sendId === undefined) {
      this.output.note('this send has no id, so it cannot be waited on');
      return;
    }
    // The DAEMON waits (the shell gives a plugin no clock): each round holds the status read open for up to
    // WAIT_ROUND_MS, and returns the moment the fate settles. At most WAIT_ROUNDS rounds: the shell gives this half no
    // clock, so the bound is a COUNT of checks, and the closing note counts them rather than claiming minutes (a round the
    // daemon ends early, a second waiter for the same send or a daemon that stops, is a check that waited less).
    let record: SendRecord | undefined;
    for (let round = 0; round < WAIT_ROUNDS; round += 1) {
      record = await this.gateway.sendStatus(result.ferret, sendId, WAIT_ROUND_MS);
      if (record === undefined) {
        // A queued message has a row of its own, so a send the daemon has no row for is one it does not know: it ends the
        // wait at once instead of looping. It does not say the message was lost, so it is no failure a script would answer
        // by sending it again.
        this.output.note(
          `the daemon has no record of this send, so there is nothing to wait for (see \`fy queue ${reference}\`); check where it went before sending it again`,
        );
        return;
      }
      if (SETTLED_SEND_FATES.has(record.fate)) {
        // A cancelled message was not delivered either; it fails the wait as a proven absence does.
        if (record.fate === 'timed_out' || record.fate === 'cancelled') throw new CommandError(describeFate(record));
        this.output.note(describeFate(record));
        return;
      }
    }
    this.output.note(
      `still ${describeFate(record as SendRecord)} after ${WAIT_ROUNDS} checks of up to ${WAIT_ROUND_MS / 1_000}s each`,
    );
  }

  /**
   * Parks the caller until the peer replies, declared after the send lands, so a failed send never leaves this ferret
   * waiting on a message the peer was never given.
   */
  private async park(
    park: { callerFerret: string; until?: string },
    peer: { disposition: SendResult['disposition']; peerId: string; peerName: string },
  ): Promise<void> {
    const decision = describePark({
      disposition: peer.disposition,
      peer: peer.peerName,
      ...(park.until === undefined ? {} : { until: park.until }),
    });
    if (decision.parked) {
      try {
        await this.gateway.parkUntilReply(park.callerFerret, {
          peer: peer.peerId,
          ...(park.until === undefined ? {} : { until: park.until }),
          condition: `a reply from ${peer.peerName}`,
        });
      } catch (error) {
        // THE MESSAGE IS ALREADY DELIVERED, so this must not exit non-zero: a script that retries a failed send
        // would send it twice. The wait is what failed, and saying so is the whole answer.
        this.output.note(
          `message sent, but this ferret could not be parked to wait for ${peer.peerName} ` +
            `(${error instanceof Error ? error.message : String(error)}); do not send it again`,
        );
        return;
      }
    }
    this.output.note(decision.note);
  }
}
