import { localOnlyNotice, refusalNotice } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type PairingInvitation,
  renderExpired,
  renderInvitation,
  renderNoLinkToOpen,
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
const LOCAL_LINK = `https://ferretry.pages.dev/pair#v1;url=http%3A%2F%2F127.0.0.1%3A7431;code=${CODE};fp=fp`;

const invitation = (overrides: Partial<PairingInvitation> = {}): string =>
  renderInvitation({
    mint: MINT,
    offer: { kind: 'qr', link: LINK, qr: QR },
    columns: 100,
    remainingMs: 120_000,
    binaryName: 'fy',
    ...overrides,
  });

describe('pairing screen', () => {
  it('should give the short human code prominence before the compact QR and full link', () => {
    // Arrange + Act
    const actual = invitation();
    const lines = actual.split('\n');

    // Assert
    should(lines[0]).equal("Scan this with your phone's camera — it opens Ferretry ready to pair.");
    should(lines[2]).equal('PAIRING CODE');
    should(lines[3]).equal(`  ${CODE}`);
    should(actual).containEql('Or scan this compact QR:');
    should(actual).containEql(`  ${QR.split('\n')[0]}`);
    should(actual).containEql('Or open this link — copy the complete line below:');
    should(actual).containEql(LINK);
    should(actual).containEql('Expires in 2:00; the code works once.');
    // The code must appear ready to be dictated as well as read.
    should(actual).containEql('  aloud: seven foxtrot three kilo · quebec two november delta');
  });

  it('should never print the scan instruction over an address a phone cannot dial', () => {
    // THE DEFECT, AS A SCREEN. A loopback address under "scan this with your phone's camera" is the
    // exact line that wasted the owner's evening: the phone dials ITSELF and nothing says why. The
    // link stays — a browser on this machine redeems it perfectly — and the QR does not.
    const actual = invitation({
      offer: { kind: 'local-only', link: LOCAL_LINK, notice: localOnlyNotice('http://127.0.0.1:7431') },
    });

    should(actual).not.containEql("Scan this with your phone's camera");
    should(actual).not.containEql('Or scan this compact QR:');
    should(actual).not.containEql(QR.split('\n')[0]);
    should(actual.split('\n')[0]).containEql('Only a browser on this machine can redeem this link');
    should(actual).containEql('http://127.0.0.1:7431');
    should(actual).containEql('Open this link in a browser on THIS machine');
    should(actual).containEql(LOCAL_LINK);
    // Never a dead end: the audience comes with the change that widens it. Flattened, since the
    // remedy's own wrapping is not what this test is about.
    const flattened = actual.replace(/\s+/gu, ' ');
    should(flattened).containEql('publicUrl');
    should(flattened).containEql('to the address other devices reach this machine at');
    // Everything the code needs to be used by hand is still on the screen.
    should(actual).containEql(`  ${CODE}`);
    should(actual).containEql('Expires in 2:00; the code works once.');
    // The remedy and the deadline are separate thoughts, not one run-together block — whatever the
    // remedy's own word wrap does, a blank line still separates it from the deadline.
    should(actual).containEql('\n\nExpires in');
  });

  it('should draw the QR for a local-only address a relay candidate also makes redeemable elsewhere', () => {
    // THE NARROWING THIS TASK ADDS. `reach: 'local-only'` still describes the direct address alone,
    // but a relay candidate beside it means another device CAN redeem this link — through the
    // rendezvous — so the QR belongs on screen, next to the disclosure the old no-QR notice never
    // needed to make.
    const actual = invitation({
      offer: {
        kind: 'qr',
        link: LOCAL_LINK,
        qr: QR,
        notice: localOnlyNotice('http://127.0.0.1:7431', 'wss://relay.example'),
      },
    });

    should(actual.split('\n')[0]).equal("Scan this with your phone's camera — it opens Ferretry ready to pair.");
    should(actual).containEql('Or scan this compact QR:');
    should(actual).containEql(`  ${QR.split('\n')[0]}`);
    should(actual).containEql('Or open this link — copy the complete line below:');
    should(actual).containEql(LOCAL_LINK);
    // The disclosure: the rendezvous is named and what it can and cannot see.
    should(actual).containEql('wss://relay.example');
    should(actual).containEql('rendezvous');
    should(actual).containEql('can never read the code or the exchange');
    // A QR is genuinely on this screen, so nothing may say otherwise — the exact contradiction the
    // plain local-only notice would have printed if it had been reused here unchanged.
    should(actual).not.containEql('no QR is drawn');
    should(actual).containEql(`  ${CODE}`);
    should(actual).containEql('Expires in 2:00; the code works once.');
  });

  it('should draw no QR and no disclosure for a plain any-device offer', () => {
    // The ordinary case must stay ordinary: no relay was ever named, so nothing about one appears.
    const actual = invitation();

    should(actual).not.containEql('rendezvous');
    should(actual).not.containEql('relay');
  });

  it('should offer no link at all when the daemon has no address, and still print the code', () => {
    // A wildcard bind is a WORKING daemon with nothing to hand out. Refusing the mint would break
    // every default install; refusing the LINK and saying so is the whole difference.
    const actual = invitation({ offer: { kind: 'refusal', notice: refusalNotice('wildcard-bind') } });

    // No link, by any spelling: not the pairing URL, not a fragment, not a QR of either.
    should(actual).not.containEql('ferretry.pages.dev');
    should(actual).not.containEql('#v1;');
    should(actual).not.containEql(QR.split('\n')[0]);
    should(actual.split('\n')[0]).containEql('binds every interface');
    const flattened = actual.replace(/\s+/gu, ' ');
    should(flattened).containEql('publicUrl');
    should(flattened).containEql('to the address other devices reach this machine at');
    should(actual).containEql(`  ${CODE}`);
    should(actual).containEql('Expires in 2:00; the code works once.');
    // Same separation applies with no link on the screen at all.
    should(actual).containEql('\n\nExpires in');
  });

  it('should say so rather than silently doing nothing when --open has no link to open', () => {
    should(renderNoLinkToOpen()).containEql('no link to open');
  });

  it('should name the daemon without an address when there was none to name', () => {
    // The code was redeemed by a browser somebody pointed at the machine themselves. Inventing an
    // address for the success line would report a fact this command was never told.
    should(renderPaired('Pixel', 'workstation')).equal(
      'Pixel is paired with workstation — it holds its own token now.',
    );
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
      if (line === LINK) continue;
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
      .find(line => line === LINK);
    should(linkLine).equal(LINK);
  });

  it('should round the countdown up, so a live code never reads as dead', () => {
    should(renderRemaining(120_000)).equal('2:00');
    should(renderRemaining(119_001)).equal('2:00');
    should(renderRemaining(61_000)).equal('1:01');
    should(renderRemaining(1)).equal('0:01');
    should(renderRemaining(0)).equal('0:00');
    should(renderRemaining(-5_000)).equal('0:00');
    should(renderWaiting(107_400, 'qr')).equal('Waiting for the scan — 1:48 left');
  });

  it('should never call it a scan when there is nothing to scan', () => {
    // `local-only` hands the code to a browser; `refusal` hands it to nobody. Neither offer draws a
    // QR, so the live line must not send the operator looking for a camera prompt that never appears.
    should(renderWaiting(107_400, 'local-only')).equal('Waiting for the code to be redeemed — 1:48 left');
    should(renderWaiting(107_400, 'refusal')).equal('Waiting for the code to be redeemed — 1:48 left');
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
