import { describe, it } from 'bun:test';
import should from 'should';
import { daemonDisplayName } from '../../../../src/features/settings/daemon-settings.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';

describe('what every screen calls a paired machine', () => {
  const at = (daemonName?: string) =>
    daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'http://127.0.0.1:40245',
      deviceId: 'device-a',
      ...(daemonName === undefined ? {} : { daemonName }),
    });

  it('should prefer the owner label, then the name the machine gave itself, and never lead with the address', () => {
    // Act + Assert — the e2e defect read "Set up http://127.0.0.1:40245" with the host name in hand.
    should(daemonDisplayName({ ...at('workstation'), label: '  Desk  ' })).equal('Desk');
    should(daemonDisplayName({ ...at('workstation'), label: '   ' })).equal('workstation');
    should(daemonDisplayName(at('workstation'))).equal('workstation');
    // Only a pairing that predates keeping the name has nothing better than its address.
    should(daemonDisplayName(at())).equal('http://127.0.0.1:40245');
  });
});
