import {
  invitationRedeemableByAnotherDevice,
  localOnlyNotice,
  PAIRING_CODE_TTL_SECONDS,
  type PairingCodeMintResponse,
  type PairingMintOutcome,
  pairingMintOutcome,
  refusalNotice,
} from '@ferretry/protocol';
import { checkedPairUrl, pairingDaemonHost } from './link.ts';
import type {
  IBrowserOpener,
  IPairClock,
  IPairExit,
  IPairGateway,
  IPairProgress,
  IPairScreen,
  IQrEncoder,
  ITerminalSize,
} from './ports.ts';
import {
  type PairingOffer,
  renderBrowserRefused,
  renderExpired,
  renderInvitation,
  renderNoLinkToOpen,
  renderOpenedBrowser,
  renderPaired,
  renderUnconfirmed,
  renderWaiting,
} from './render.ts';

/**
 * How often the daemon is asked what became of the code.
 *
 * One second, which is also the countdown's tick: two rates would mean a screen that says `0:47` while
 * the answer beside it is three seconds stale. This command runs ON the host, so it is 120 local
 * requests for the whole life of a code.
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
  /**
   * Open the pairing link in this host's own browser.
   *
   * For the case the old flow served worst: the daemon and the browser are the
   * SAME machine, so there is nobody to scan anything and the QR was asking the
   * operator to photograph their own screen.
   */
  readonly open?: boolean;
}

export interface PairDeps {
  readonly gateway: IPairGateway;
  readonly screen: IPairScreen;
  readonly progress: IPairProgress;
  readonly exit: IPairExit;
  readonly clock: IPairClock;
  readonly qr: IQrEncoder;
  readonly terminal: ITerminalSize;
  /** Opens a URL on this host, for the same-machine case. */
  readonly browser: IBrowserOpener;
  /** What this binary is called, so every retry hint is a command the operator actually has. */
  readonly binaryName: string;
}

/**
 * Drives `fy pair`.
 *
 * The arc is: mint a code, draw it, then stay and say how it ended. Staying is the point of the command
 * as much as the QR is — the operator is watching for an ending, and a terminal that never acknowledged
 * one leaves them to guess whether pairing worked.
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
    const outcome = pairingMintOutcome(mint);
    const offer = await this.#offer(outcome, options);
    this.deps.screen.write(
      renderInvitation({
        mint,
        offer,
        columns: this.deps.terminal.columns(),
        remainingMs,
        binaryName: this.deps.binaryName,
      }),
    );
    /*
     * THE SAME-MACHINE PATH, ATTEMPTED AND THEN REPORTED HONESTLY.
     *
     * Asked for, never assumed: opening a browser on a host whose operator did
     * not request it is a side effect nobody consented to, and on a shared or
     * headless box it is worse than useless. When it IS asked for and the host
     * cannot do it — no display, an SSH session, a desktop that refuses — the
     * screen already holds the QR and the link, so the honest line is that it
     * did not open and the code is still good. Claiming a browser opened when
     * none did would leave the operator staring at a window that never appears.
     */
    if (options.open === true) {
      this.deps.screen.write(await this.#open(offer));
    }
    // `--no-wait` is for a script that wants the screen and nothing else; there is no one to tell.
    if (options.wait === false) return;
    await this.#watch(mint, offer, outcome.kind === 'invitation' ? pairingDaemonHost(outcome.daemonUrl) : undefined);
  }

  /**
   * What this screen can offer, decided from the DAEMON'S answer and never from this host.
   *
   * A QR IS ENCODED ONLY WHEN ANOTHER DEVICE CAN REDEEM IT. `reach: 'local-only'` describes the
   * DIRECT address alone — it is right for a browser on this machine and dead on any other — but a
   * `discoveredRelayUrl` beside it means a different device can still redeem this link, because the
   * scanning phone reads the same hosted directory advertisement the daemon did and dials that
   * rendezvous itself when loopback fails. `invitationRedeemableByAnotherDevice` is the one place that
   * judgement is made, so this does not re-derive it. Drawing a QR for a direct address alone dead on
   * a phone is the exact failure this command shipped; that case — `local-only`, nothing discoverable
   * — is still the only one that reaches the no-QR offer below.
   *
   * A RELAYED LOCAL-ONLY OFFER CARRIES BOTH. The QR is drawn because the rendezvous makes it
   * redeemable, and `localOnlyNotice` is passed the same address, so the screen also discloses that a
   * rendezvous now sees this exchange's metadata and names the direct-bind upgrade that would need
   * none. THE QR ITSELF NAMES NO RENDEZVOUS: the link is the ordinary `v1` fragment, and the address
   * disclosed here never enters it.
   */
  async #offer(outcome: PairingMintOutcome, options: PairOptions): Promise<PairingOffer> {
    if (outcome.kind === 'refusal') return { kind: 'refusal', notice: refusalNotice(outcome.refusal) };
    const link = checkedPairUrl(outcome);
    if (!invitationRedeemableByAnotherDevice(outcome)) {
      return { kind: 'local-only', link, notice: localOnlyNotice(outcome.daemonUrl) };
    }
    const qr = await this.deps.qr.encode(link, options.large === true ? 'large' : 'compact');
    if (outcome.reach !== 'local-only') return { kind: 'qr', link, qr };
    return { kind: 'qr', link, qr, notice: localOnlyNotice(outcome.daemonUrl, outcome.discoveredRelayUrl) };
  }

  /**
   * `--open`, for the case the QR serves worst: the daemon and the browser are the same machine.
   *
   * IT IS THE WHOLE ANSWER FOR A LOCAL-ONLY ADDRESS — that browser is precisely the one caller such a
   * link is for — so it is attempted there exactly as for a dialable one. With no link there is
   * nothing to attempt, and saying so beats a window that never appears.
   */
  async #open(offer: PairingOffer): Promise<string> {
    if (offer.kind === 'refusal') return renderNoLinkToOpen();
    return (await this.deps.browser.open(offer.link))
      ? renderOpenedBrowser()
      : renderBrowserRefused(this.deps.binaryName);
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
  async #watch(mint: PairingCodeMintResponse, offer: PairingOffer, daemonHost: string | undefined): Promise<void> {
    const deadline = Date.parse(mint.expiresAt);
    let unanswered: string | undefined;
    while (this.deps.clock.now() < deadline) {
      this.deps.progress.start(renderWaiting(deadline - this.deps.clock.now(), offer.kind));
      try {
        const status = await this.deps.gateway.status(mint.pairingId);
        if (status.status === 'redeemed') {
          this.deps.progress.succeed(renderPaired(status.deviceName, mint.daemonName, daemonHost));
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
