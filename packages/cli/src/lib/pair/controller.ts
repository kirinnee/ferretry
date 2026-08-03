import { PAIRING_CODE_TTL_SECONDS, type PairingCodeMintResponse } from '@ferretry/protocol';
import { checkedPairUrl, pairingDaemonHost } from './link.ts';
import type {
  IPairClock,
  IPairExit,
  IPairGateway,
  IPairProgress,
  IPairScreen,
  IQrEncoder,
  ITerminalSize,
} from './ports.ts';
import { renderExpired, renderInvitation, renderPaired, renderUnconfirmed, renderWaiting } from './render.ts';

/**
 * How often the daemon is asked what became of the code.
 *
 * One second, which is also the countdown's tick: two rates would mean a screen that says `0:47` while
 * the answer beside it is three seconds stale. The route is host-scoped and loopback-only, so this is
 * 120 local requests for the whole life of a code.
 */
export const PAIR_POLL_INTERVAL_MS = 1_000;

/**
 * How much longer than the stated window a grant may claim before it is refused.
 *
 * Room for a slow round trip, not for a different policy. A daemon minting long-lived codes has broken
 * the part of the design that makes a shoulder-surfed code worthless, and printing a QR for one would
 * make this command complicit in that rather than a witness to it.
 */
const TTL_TOLERANCE_MS = 30_000;

export interface PairOptions {
  /** Commander sets this `false` for `--no-wait`. */
  readonly wait?: boolean;
  /** Draw the QR at full size, for a camera that will not focus on the compact one. */
  readonly large?: boolean;
}

export interface PairDeps {
  readonly gateway: IPairGateway;
  readonly screen: IPairScreen;
  readonly progress: IPairProgress;
  readonly exit: IPairExit;
  readonly clock: IPairClock;
  readonly qr: IQrEncoder;
  readonly terminal: ITerminalSize;
  /** What this binary is called, so every retry hint is a command the operator actually has. */
  readonly binaryName: string;
}

/**
 * Drives `fy pair`.
 *
 * The arc is: mint a code, draw it, then stay and say how it ended. Staying is the point of the command
 * as much as the QR is — the operator is looking at a phone, and a terminal that never acknowledged the
 * scan leaves them to guess whether pairing worked.
 *
 * THERE IS NO --name. The daemon's mint is bodyless and the DEVICE supplies its own name when it
 * redeems, so a host-side label would have nowhere to go; the name in the success line is the one the
 * device sent.
 *
 * THREE ENDINGS, AND THEY ARE NOT INTERCHANGEABLE. Redeemed, expired-unused, and expired-with-no-answer.
 * The third exists because a daemon that stops answering mid-countdown is not evidence that nobody
 * scanned the code, and saying "expired unused" there would be a confident report of something this
 * command does not know.
 */
export class PairController {
  constructor(private readonly deps: PairDeps) {}

  async pair(options: PairOptions): Promise<void> {
    const mint = await this.deps.gateway.mint();
    const remainingMs = this.#lifespan(mint);
    const link = checkedPairUrl(mint);
    const qr = await this.deps.qr.encode(link, options.large === true ? 'large' : 'compact');
    this.deps.screen.write(
      renderInvitation({
        mint,
        link,
        qr,
        columns: this.deps.terminal.columns(),
        remainingMs,
        binaryName: this.deps.binaryName,
      }),
    );
    // `--no-wait` is for a script that wants the screen and nothing else; there is no one to tell.
    if (options.wait === false) return;
    await this.#watch(mint);
  }

  /**
   * How long the code has, refusing a mint this command cannot honestly draw.
   *
   * An already-dead code and an implausibly long-lived one are both refused before a QR exists, because
   * the screen's whole claim is that what it shows works for as long as it says.
   */
  #lifespan(mint: PairingCodeMintResponse): number {
    const remaining = Date.parse(mint.expiresAt) - this.deps.clock.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      throw new Error('the daemon minted a code that has already expired — check the clock on this host');
    }
    if (remaining > PAIRING_CODE_TTL_SECONDS * 1_000 + TTL_TOLERANCE_MS) {
      throw new Error(
        `the daemon minted a code that outlives the ${PAIRING_CODE_TTL_SECONDS}s pairing window — refusing to show it`,
      );
    }
    return remaining;
  }

  /** Count the code down, and say which of the three endings happened. */
  async #watch(mint: PairingCodeMintResponse): Promise<void> {
    const deadline = Date.parse(mint.expiresAt);
    let unanswered: string | undefined;
    while (this.deps.clock.now() < deadline) {
      this.deps.progress.start(renderWaiting(deadline - this.deps.clock.now()));
      try {
        const status = await this.deps.gateway.status(mint.pairingId);
        if (status.status === 'redeemed') {
          this.deps.progress.succeed(
            renderPaired(status.deviceName, mint.daemonName, pairingDaemonHost(mint.daemonUrl)),
          );
          return;
        }
        if (status.status === 'expired') return this.#died();
        // A daemon that answers again has cleared the doubt an earlier failure raised.
        unanswered = undefined;
      } catch (reason) {
        unanswered = reason instanceof Error ? reason.message : 'the daemon did not answer';
      }
      await this.deps.clock.sleep(PAIR_POLL_INTERVAL_MS);
    }
    if (unanswered === undefined) return this.#died();
    this.deps.progress.fail(renderUnconfirmed(unanswered, this.deps.binaryName));
    this.deps.exit.setExitCode(1);
  }

  /** The code died unused. A non-zero exit, because pairing is what was asked for and it did not happen. */
  #died(): void {
    this.deps.progress.fail(renderExpired(this.deps.binaryName));
    this.deps.exit.setExitCode(1);
  }
}
