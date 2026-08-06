import { describe, it } from 'bun:test';
import { localOnlyNotice, refusalNotice } from '@ferretry/protocol';
import should from 'should';
import { describePairingAdvertisement } from '../../../bin/fyd.ts';

/**
 * `--check` IS THE COMMAND SOMEBODY RUNS WHEN PAIRING WILL NOT WORK, and until now it answered every
 * question except that one: harnesses, doctor, carrier, grants, address — and nothing about whether
 * the code this daemon mints could be redeemed by anything but its own browser.
 *
 * What is asserted here is the WIRING and the SOURCE of the words, not the words themselves. The
 * sentences belong to the protocol, where `fy pair` and the browser's Add-a-device panel read the
 * same two functions; a copy of the text in this file would be the fourth wording of one fact and
 * would go stale the moment somebody improved the other three.
 */
describe('the pairing advertisement `--check` reports', () => {
  it('should name the dialable address, and no remedy, when any device could redeem a code', () => {
    // Act
    const derived = describePairingAdvertisement({
      kind: 'address',
      url: 'http://192.168.1.10:7431',
      origin: 'derived',
    });
    const operator = describePairingAdvertisement({
      kind: 'address',
      url: 'https://box.example.test',
      origin: 'operator',
    });

    // Assert — one line, because there is nothing to fix. The origin is carried for the reason the
    // whole provenance surface exists: "this one I chose" and "this one was chosen for me" are
    // different answers to "why is my phone being sent there".
    should(derived).have.length(1);
    should(derived[0]).startWith('pairing      ');
    should(derived[0]).containEql('http://192.168.1.10:7431');
    should(derived[0]).containEql('derived');
    should(operator[0]).containEql('operator');
  });

  it('should say who can redeem a local-only link and print the protocol’s own remedy beneath it', () => {
    // Arrange — the default single-machine install, which is where this blocker lives.
    const notice = localOnlyNotice('http://127.0.0.1:7431');

    // Act
    const lines = describePairingAdvertisement({ kind: 'local-only', url: 'http://127.0.0.1:7431' });

    // Assert — the audience on the labelled row, the remedy indented beneath it as a `!` line, both
    // taken whole from the package `fy pair` and the browser panel read.
    should(lines).deepEqual([`pairing      ${notice.audience}`, `             ! ${notice.remedy}`]);
  });

  it('should report each refusal with the remedy that is true for it', () => {
    // Act + Assert — a wildcard bind and a missing port need different things done about them, and
    // this command must not flatten them back into one sentence.
    for (const refusal of ['wildcard-bind', 'no-port', 'loopback-bind'] as const) {
      should(describePairingAdvertisement({ kind: 'none', refusal })).deepEqual([
        `pairing      ${refusalNotice(refusal).audience}`,
        `             ! ${refusalNotice(refusal).remedy}`,
      ]);
    }
  });

  it('should align its label with every other row the report prints', () => {
    // The columns are the report: a row that indents differently reads as a different section.
    const lines = describePairingAdvertisement({ kind: 'none', refusal: 'no-port' });
    should(lines[0]?.indexOf('This')).equal('state home   '.length);
    should(lines[1]).startWith('             ! ');
  });
});
