import type { AdvertisementNotice, PairingCodeMintResponse } from '@ferretry/protocol';
import { QR_INDENT, qrColumns, qrFitsTerminal } from './qr.ts';

/**
 * The pairing screen.
 *
 * Someone running `fy pair` for the first time should not have to read anything else, so the screen
 * is ordered by what an operator can use most reliably: one instruction, the short code and its
 * spoken form, then the compact QR and full link, then when it dies.
 *
 * THE CODE IS PRINTED THREE WAYS ON PURPOSE. Scanned, it is inside the QR. Typed, it is the grouped
 * `code` line. Dictated down a phone line, it is the `aloud` line — because `7F3K` read out is where
 * pairing over a call actually fails, and the NATO alphabet is what people already reach for.
 *
 * NOTHING HERE IS EVER WRITTEN ANYWHERE ELSE. The code lives in this string, on this screen, for two
 * minutes. It is not logged, not persisted, and never passed as an argument to anything.
 */

const INDENT = ' '.repeat(QR_INDENT);

/** How each symbol is said out loud. The pairing alphabet excludes every symbol without a distinct name. */
const SPOKEN: Record<string, string> = {
  A: 'alfa',
  B: 'bravo',
  C: 'charlie',
  D: 'delta',
  E: 'echo',
  F: 'foxtrot',
  G: 'golf',
  H: 'hotel',
  J: 'juliett',
  K: 'kilo',
  M: 'mike',
  N: 'november',
  P: 'papa',
  Q: 'quebec',
  R: 'romeo',
  S: 'sierra',
  T: 'tango',
  V: 'victor',
  W: 'whiskey',
  X: 'x-ray',
  Y: 'yankee',
  Z: 'zulu',
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'five',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
  '9': 'nine',
};

/** A code as it should be dictated: each group spelled, the groups kept apart. */
export function spellCode(code: string): string {
  return code
    .split('-')
    .map(group =>
      Array.from(group)
        .map(symbol => SPOKEN[symbol] ?? symbol)
        .join(' '),
    )
    .join(' · ');
}

/**
 * What is left on the clock, as `m:ss`.
 *
 * Rounded UP, so the last second is shown as `0:01` rather than as `0:00` beside a code that still
 * works. A countdown that reads zero while the code lives is the same lie as a QR left on screen
 * after it dies, just in the other direction.
 */
export function renderRemaining(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * WHAT THIS SCREEN HAS TO OFFER — a QR, a link only this machine can use, or neither.
 *
 * ONE FIELD, NOT A LINK AND A FLAG. A QR beside a boolean saying whether to draw it is two facts that
 * can disagree, and the disagreement is the defect: a QR was drawn for an address no other device
 * could dial, so a phone read `http://127.0.0.1:…` and dialled ITSELF. Here the QR exists only in the
 * case that has one, and the two cases that do not carry the sentence saying who can redeem what is
 * left — which is the whole rule: never offer a link without saying who can redeem it.
 */
export type PairingOffer =
  /** An address any device can dial. The QR is already drawn in block characters. */
  | { readonly kind: 'qr'; readonly link: string; readonly qr: string }
  /** An address only a browser on this machine can use. A link, deliberately no QR, and why. */
  | { readonly kind: 'local-only'; readonly link: string; readonly notice: AdvertisementNotice }
  /** No address to hand out at all. The code is still live; there is just nowhere to point it. */
  | { readonly kind: 'refusal'; readonly notice: AdvertisementNotice };

/** Everything the screen needs, gathered so the layout is a pure function of it. */
export interface PairingInvitation {
  readonly mint: PairingCodeMintResponse;
  /** What can be handed to the device being added, and who that device may be. */
  readonly offer: PairingOffer;
  /** The terminal width, or nothing when it will not say. */
  readonly columns: number | undefined;
  /** How long the code has left at the moment of printing. */
  readonly remainingMs: number;
  /** What this binary is called, so the retry hint is the command the operator actually has. */
  readonly binaryName: string;
}

const indented = (block: string): string =>
  block
    .split('\n')
    .map(line => (line === '' ? line : `${INDENT}${line}`))
    .join('\n');

/**
 * Greedy word wrap for the screen's prose.
 *
 * Only the prose. The code, its spelling and the link are laid out to be read or copied whole, and the
 * link is a single unbreakable token anyway — wrapping it would invite someone to copy half of it.
 */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (candidate.length > width && line !== '') {
      lines.push(line);
      line = word;
      continue;
    }
    line = candidate;
  }
  lines.push(line);
  return lines;
}

/**
 * Said instead of a QR that would wrap: what is wrong, by how much, and the two ways out.
 *
 * Wrapped to the window that was just called too narrow, because a complaint about wrapping that
 * itself wraps is not a message anyone trusts.
 */
function tooNarrow(invitation: PairingInvitation, qr: string, columns: number): string {
  const needed = qrColumns(qr) + QR_INDENT;
  const notice =
    `The QR needs ${needed} columns and this window has ${columns}, so it is not drawn — a QR that ` +
    `wraps cannot be scanned. Widen the window and run \`${invitation.binaryName} pair\` again, or ` +
    'open the link below on the phone.';
  return wrapText(notice, Math.max(1, columns - QR_INDENT))
    .map(line => `${INDENT}${line}`)
    .join('\n');
}

function qrBlock(invitation: PairingInvitation, qr: string): string {
  const columns = invitation.columns;
  if (columns !== undefined && !qrFitsTerminal(qr, columns)) return tooNarrow(invitation, qr, columns);
  return indented(qr);
}

/**
 * The whole screen, from the instruction down to the deadline.
 *
 * THE HEADLINE IS DECIDED BY THE OFFER, not fixed. "Scan this with your phone" printed above a
 * loopback address is the instruction that wasted the owner's evening: the screen said the one thing
 * that could not work. Each offer says what this code can actually be used for, and the two that
 * cannot reach a phone say so first, before the code, where somebody reading top-down will see it.
 */
export function renderInvitation(invitation: PairingInvitation): string {
  const text = (value: string): string => wrapText(value, invitation.columns ?? value.length).join('\n');
  const detail = (value: string): string =>
    wrapText(value, Math.max(1, (invitation.columns ?? Number.POSITIVE_INFINITY) - INDENT.length))
      .map(line => `${INDENT}${line}`)
      .join('\n');
  const offer = invitation.offer;
  const headline =
    offer.kind === 'qr'
      ? "Scan this with your phone's camera — it opens Ferretry ready to pair."
      : offer.notice.audience;
  const body =
    offer.kind === 'qr'
      ? [
          '',
          text('Or scan this compact QR:'),
          qrBlock(invitation, offer.qr),
          '',
          text('Or open this link — copy the complete line below:'),
          offer.link,
        ]
      : offer.kind === 'local-only'
        ? [
            '',
            text('Open this link in a browser on THIS machine — copy the complete line below:'),
            offer.link,
            '',
            text(offer.notice.remedy),
          ]
        : ['', text(offer.notice.remedy)];
  return [
    text(headline),
    '',
    'PAIRING CODE',
    `${INDENT}${invitation.mint.code}`,
    detail(`aloud: ${spellCode(invitation.mint.code)}`),
    ...body,
    text(`Expires in ${renderRemaining(invitation.remainingMs)}; the code works once.`),
  ].join('\n');
}

/**
 * Said when `--open` was asked for and there is no link to open.
 *
 * The screen above already says why there is none, so this does not repeat it. What it must not do is
 * stay silent: somebody who typed `--open` is waiting for a window.
 */
export function renderNoLinkToOpen(): string {
  return 'There is no link to open — this daemon has no address to hand out, and the reason is above.';
}

/** The live line while the code is alive. */
export function renderWaiting(remainingMs: number): string {
  return `Waiting for the scan — ${renderRemaining(remainingMs)} left`;
}

/**
 * The ending the operator came back to the terminal for.
 *
 * The device's token is deliberately absent: it belongs to the device, the terminal has no use for it,
 * and a token on a screen is a token in a screenshot.
 *
 * `deviceName` is the one piece of this screen the DEVICE chose, so it is attacker-influenced text. It
 * is safe to print because the protocol refuses a name carrying a control or format character — an
 * escape sequence here would otherwise rewrite the operator's terminal — and it is printed in full
 * rather than truncated so nothing is hidden from whoever is deciding this pairing was expected.
 *
 * `daemonHost` is ABSENT when this daemon had no address to hand out. Something redeemed the code
 * anyway — a browser somebody pointed at the machine themselves — so the ending is reported without
 * naming an address, rather than inventing one it was never told.
 */
export function renderPaired(deviceName: string, daemonName: string, daemonHost?: string): string {
  const where = daemonHost === undefined ? daemonName : `${daemonName} (${daemonHost})`;
  return `${deviceName} is paired with ${where} — it holds its own token now.`;
}

/** The other ordinary ending: nobody scanned it. */
export function renderExpired(binaryName: string): string {
  return `The code expired unused. Run \`${binaryName} pair\` for a new one.`;
}

/**
 * The ending that must not be mistaken for either of the other two.
 *
 * The daemon stopped answering, so whether the code was claimed is genuinely unknown. Reporting the
 * benign reading — "expired unused" — would tell the operator a device is not enrolled when it may
 * be, so this says what it does not know and refuses to round it off.
 */
export function renderUnconfirmed(reason: string, binaryName: string): string {
  return [
    `The code has expired and whether anything used it is unknown: ${reason}.`,
    'Treating it as unpaired rather than reporting an ending on no evidence.',
    `Run \`${binaryName} pair\` again once the daemon answers.`,
  ].join(' ');
}

/**
 * Said when `--open` handed the link to this host's browser.
 *
 * The QR stays on the screen above it. A reader whose browser opened does not
 * need it, and a reader who asked for `--open` on a machine that ALSO has a
 * phone nearby may still prefer the phone — withdrawing the code the moment a
 * window opened would take away a choice for no reason.
 */
export function renderOpenedBrowser(): string {
  return 'Opened the pairing link in this host’s browser — it lands in Ferretry already paired.';
}

/**
 * Said when it did not, which is not an error.
 *
 * A headless box, an SSH session and a locked-down desktop are all ordinary
 * places to run this. The code is untouched and the screen above still holds
 * whatever this daemon had to offer, so this says what happened and points at
 * what still works rather than reporting a failure the operator has to interpret.
 *
 * IT DOES NOT NAME THE QR, because there is not always one: a local-only address
 * is shown as a link with no QR, and sending somebody to scan a code that is not
 * on their screen is the same dead end in a new place.
 */
export function renderBrowserRefused(binaryName: string): string {
  return (
    'Could not open a browser on this host — no display, a remote shell, or a desktop that declined. ' +
    `The code above is untouched: use whatever the screen above is showing — the QR, the link, or the code itself. ` +
    `\`${binaryName} pair\` without --open prints the same screen.`
  );
}
