import { describe, it } from 'bun:test';
import should from 'should';
import {
  daemonConnection,
  daemonDisplayName,
  distinctDaemonName,
  replacedPairing,
} from '../../../app/shell-pairing.ts';

/**
 * G95 (last clause): same-named machines are told apart by address, so a prompt naming one says WHICH machine wants the
 * passkey. Copied from today's `tests/unit/features/settings/daemon-display-name.test.ts`.
 */
describe('G95 what every screen calls a paired machine', () => {
  const at = (daemonName?: string) =>
    daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'http://127.0.0.1:40245',
      deviceId: 'device-a',
      ...(daemonName === undefined ? {} : { daemonName }),
    });

  it('G95 should prefer the owner label, then the name the machine gave itself, and never lead with the address', () => {
    should(daemonDisplayName({ ...at('workstation'), label: '  Desk  ' })).equal('Desk');
    should(daemonDisplayName({ ...at('workstation'), label: '   ' })).equal('workstation');
    should(daemonDisplayName(at('workstation'))).equal('workstation');
    should(daemonDisplayName(at())).equal('http://127.0.0.1:40245');
  });
});

describe('G95 telling paired machines with one name apart', () => {
  /** Noon UTC, so the day is the same in every timezone a test runner is in. */
  const OCT_3 = Date.parse('2026-10-03T12:00:00.000Z');
  const OCT_9 = Date.parse('2026-10-09T12:00:00.000Z');
  const pairing = (daemonId: string, baseUrl: string, pairedAt?: number) => ({
    ...daemonConnection({
      daemonId: `fy_daemon_${daemonId}`,
      baseUrl,
      deviceId: `device-${daemonId}`,
      daemonName: 'kirin-box',
    }),
    ...(pairedAt === undefined ? {} : { pairedAt }),
  });

  it('G95 should leave a machine with a name of its own alone', () => {
    const only = pairing('8eET_ZaaaaaaAAAAAAA', 'http://10.0.0.5:9000', OCT_3);
    should(distinctDaemonName(only, [only])).equal('kirin-box');
  });

  it('G95 should call the pairing a reset left behind the old one, and the live one by its name alone', () => {
    const old = pairing('8eET_ZaaaaaaAAAAAAA', 'http://10.0.0.5:9000', OCT_3);
    const live = pairing('Qz11_kbbbbbbBBBBBBB', 'http://10.0.0.5:9000', OCT_9);
    const paired = [old, live];

    should(replacedPairing(old, paired)).be.true();
    should(replacedPairing(live, paired)).be.false();
    should(distinctDaemonName(old, paired)).equal('kirin-box (old pairing)');
    should(distinctDaemonName(live, paired)).equal('kirin-box');
  });

  it('G95 should tell two live machines apart by address, and never by fingerprint', () => {
    const a = pairing('aaaa', 'http://127.0.0.1:40245', OCT_3);
    const b = pairing('bbbb', 'http://127.0.0.1:40246', OCT_3);
    should(distinctDaemonName(a, [a, b])).equal('kirin-box (127.0.0.1:40245)');
    should(distinctDaemonName(b, [a, b])).equal('kirin-box (127.0.0.1:40246)');
  });

  it('G95 should fall back to the day each was paired when even the address is shared and neither is newer', () => {
    const a = pairing('aaaa', 'http://10.0.0.5:9000', OCT_3);
    const b = pairing('bbbb', 'http://10.0.0.5:9000', OCT_3);
    const undated = pairing('cccc', 'http://10.0.0.5:9000');
    const alsoUndated = pairing('dddd', 'http://10.0.0.5:9000');

    should(distinctDaemonName(a, [a, b])).equal('kirin-box (paired 3 Oct)');
    should(distinctDaemonName(undated, [undated, alsoUndated])).equal('kirin-box (another pairing)');
    for (const name of [distinctDaemonName(a, [a, b]), distinctDaemonName(undated, [undated, alsoUndated])])
      should(name).not.containEql('fy_daemon');
  });
});
