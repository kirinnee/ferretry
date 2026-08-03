import { describe, it } from 'bun:test';
import should from 'should';
import {
  type PairingInvitation,
  renderExpired,
  renderInvitation,
  renderPaired,
  renderRemaining,
  renderUnconfirmed,
  renderWaiting,
  spellCode,
  wrapText,
} from '../../../src/lib/pair/render';
import { CODE, MINT } from './fixtures';

const QR = ['▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█▀▄█', '█▄▀▄█▄▀▄█▄▀▄█▄▀▄█▄▀▄█▄▀▄'].join('\n');
const LINK = `https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fbox.tailnet-abc.ts.net;code=${CODE};fp=fp`;

const invitation = (overrides: Partial<PairingInvitation> = {}): string =>
  renderInvitation({
    mint: MINT,
    link: LINK,
    qr: QR,
    columns: 100,
    remainingMs: 120_000,
    binaryName: 'fy',
    ...overrides,
  });

describe('pairing screen', () => {
  it('should lead with one instruction, then the QR, then the code', () => {
    // Arrange + Act
    const actual = invitation();
    const lines = actual.split('\n');

    // Assert
    should(lines[0]).equal("Scan this with your phone's camera — it opens Ferretry ready to pair.");
    should(lines[2]).equal(`  ${QR.split('\n')[0]}`);
    should(actual).containEql(`  code     ${CODE}`);
    should(actual).containEql(`  link     ${LINK}`);
    should(actual).containEql('  expires  in 2:00, and the code works once');
    // The code must appear ready to be dictated as well as read.
    should(actual).containEql('  aloud    seven foxtrot three kilo · quebec two november delta');
  });

  it('should withhold a QR that would wrap and explain it within the same window', () => {
    // Arrange + Act
    const actual = invitation({ columns: 20 });

    // Assert
    should(actual).not.containEql(QR.split('\n')[0]);
    // The notice is itself wrapped to the window it just called too narrow, so it is asserted in the
    // pieces it is allowed to break into rather than as one line.
    should(actual).containEql('The QR needs 26');
    should(actual).containEql('window has 20');
    should(actual).containEql('`fy pair`');
    // A complaint about wrapping must not itself wrap. Only the link is exempt.
    for (const line of actual.split('\n')) {
      if (line.startsWith('  link     http')) continue;
      should(line.length).be.belowOrEqual(20);
    }
  });

  it('should still draw the QR when the terminal reports no width', () => {
    should(invitation({ columns: undefined })).containEql(`  ${QR.split('\n')[0]}`);
  });

  it('should never break the link across lines, however narrow the window', () => {
    // Half a copied link is worse than a long one, and the link has no spaces to break on.
    const linkLine = invitation({ columns: 20 })
      .split('\n')
      .find(line => line.startsWith('  link     http'));
    should(linkLine).equal(`  link     ${LINK}`);
  });

  it('should round the countdown up, so a live code never reads as dead', () => {
    should(renderRemaining(120_000)).equal('2:00');
    should(renderRemaining(119_001)).equal('2:00');
    should(renderRemaining(61_000)).equal('1:01');
    should(renderRemaining(1)).equal('0:01');
    should(renderRemaining(0)).equal('0:00');
    should(renderRemaining(-5_000)).equal('0:00');
    should(renderWaiting(107_400)).equal('Waiting for the scan — 1:48 left');
  });

  it('should spell every symbol a code can contain and pass through anything else', () => {
    should(spellCode('7F3K-Q2ND')).equal('seven foxtrot three kilo · quebec two november delta');
    should(spellCode('ABCD-EFGH')).equal('alfa bravo charlie delta · echo foxtrot golf hotel');
    should(spellCode('JKMN-PRST')).equal('juliett kilo mike november · papa romeo sierra tango');
    should(spellCode('VWXY-Z456')).equal('victor whiskey x-ray yankee · zulu four five six');
    should(spellCode('89')).equal('eight nine');
    // A symbol outside the pairing alphabet is shown rather than silently dropped.
    should(spellCode('a')).equal('a');
  });

  it('should wrap prose on word boundaries and never lose a word', () => {
    should(wrapText('one two three four', 9)).eql(['one two', 'three', 'four']);
    // A single word longer than the width survives whole rather than being cut in half.
    should(wrapText('unbreakable', 4)).eql(['unbreakable']);
    should(wrapText('', 10)).eql(['']);
  });

  it('should name the device and its daemon on success, and never its token', () => {
    // Arrange + Act
    const actual = renderPaired("Kirin's phone", MINT.daemonName, 'box.tailnet-abc.ts.net');

    // Assert — the whole line, so no field of the pairing result can appear in it unnoticed.
    should(actual).equal(
      "Kirin's phone is paired with workstation (box.tailnet-abc.ts.net) — it holds its own token now.",
    );
    should(actual).not.containEql(CODE);
    should(actual).not.containEql(MINT.daemonId);
  });

  it('should distinguish a code nobody used from a code whose fate is unknown', () => {
    should(renderExpired('fy')).equal('The code expired unused. Run `fy pair` for a new one.');
    const unconfirmed = renderUnconfirmed('fetch failed', 'fy');
    should(unconfirmed).containEql('whether anything used it is unknown: fetch failed');
    should(unconfirmed).containEql('Treating it as unpaired');
    should(unconfirmed).not.containEql('expired unused');
  });
});
