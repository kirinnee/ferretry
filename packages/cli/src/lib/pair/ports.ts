import type { IFyApiClient, PairingCodeMintResponse, PairingCodeStatusResponse, PairingId } from '@ferretry/protocol';

/**
 * Where the pairing screen is drawn.
 *
 * Separate from the shared IO port for one reason: this text contains a QR, and a QR is drawn with
 * block characters whose only job is contrast. The shared port tints everything it prints, and a
 * tinted QR is a QR that may not decode on a terminal whose palette fights the camera. So the
 * pairing screen is written verbatim, colour left to the terminal.
 */
export interface IPairScreen {
  write(text: string): void;
}

/** The exit-status slice of the shared IO port: pairing that did not happen must not exit zero. */
export interface IPairExit {
  setExitCode(code: number): void;
}

/**
 * The one live line under the pairing screen: the countdown while the code is alive, then how it
 * ended. One line rather than a growing log, because a countdown that scrolls is a countdown that
 * pushes the QR off the screen.
 */
export interface IPairProgress {
  start(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
}

/** Time, injected so a countdown can be proved without one elapsing. */
export interface IPairClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

/**
 * Turns a pairing link into a QR drawn with block characters.
 *
 * `compact` halves the row count so the code fits an unscrolled window; `large` spends a full row per
 * module for a camera that will not focus on the dense one.
 */
export interface IQrEncoder {
  encode(value: string, size: 'compact' | 'large'): Promise<string>;
}

/** How wide the terminal is, or nothing when it will not say — a pipe never does. */
export interface ITerminalSize {
  columns(): number | undefined;
}

/**
 * Hands a URL to whatever this host uses to open one.
 *
 * THE POINT OF THIS PORT is the case where the daemon and the browser are the
 * SAME MACHINE, which is the ordinary first run and the one the old flow served
 * worst: it printed a QR and waited for the operator to photograph their own
 * screen with a phone, so the phone could carry a code back to a browser
 * eighteen inches away. `--open` sends the link straight to the local browser,
 * and the reader lands in the app already paired.
 *
 * `open` RESOLVES TO WHETHER IT WORKED rather than throwing. A headless box, a
 * remote shell, an SSH session without forwarding and a locked-down desktop are
 * all ordinary places to run this, and none of them is an error — the QR and the
 * link are still on the screen, which is what the reader falls back to. What
 * would be a real failure is reporting success on a browser that never opened.
 */
export interface IBrowserOpener {
  open(url: string): Promise<boolean>;
}

/**
 * The daemon calls pairing needs.
 *
 * `status` takes the pairing id and never the code. That is why a mint answers with both: a pairing id
 * is not a credential, so it may sit in a URL path and its access log, and the code may not.
 */
export interface IPairGateway {
  /** Ask the daemon to mint a single-use code. */
  mint(): Promise<PairingCodeMintResponse>;
  /** Whether that code is still waiting, was redeemed, or has died. */
  status(pairingId: PairingId): Promise<PairingCodeStatusResponse>;
}

/** The only client capability the pairing gateway consumes. */
export type PairingApiClient = Pick<IFyApiClient, 'request'>;
