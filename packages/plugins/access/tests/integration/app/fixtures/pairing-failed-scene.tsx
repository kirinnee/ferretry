/**
 * The browser entry for "Pairing failed" over fake data: the REAL `PairingScreen`, opened from a pairing link whose
 * redemption fails the way the owner's SSH-tunnel case did (the direct address refused, the relay saying the machine
 * is not connected). No daemon, no real code: the seed is a fixed fake.
 *
 *   ?theme=<family>-<mode>
 *
 * The failure text is what Connections' `PairingUnreachableError` writes for those two legs
 * (`packages/plugins/connections/tests/unit/app/pairing-walk.test.ts` pins it); Access cannot import Connections, so
 * the text is repeated here as fake data.
 */

import { createRoot } from 'react-dom/client';
import { PairingScreen } from '../../../../app/features/pairing/pairing-screen.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const SEED = { daemonUrl: 'http://127.0.0.1:7617', daemonId: 'fake-daemon', code: 'FAKE-0000' };

const MESSAGE = [
  'First, directly at 127.0.0.1:7617: no answer. 127.0.0.1 only works on that machine itself, or through an SSH tunnel from this computer.',
  "Then Ferretry's relay (relay.example) answered, but the machine is not connected to it, so it could not carry the pairing.",
  'Most likely fix:',
  '1. If you use an SSH tunnel: check it is still running, and that its local port was free (look for "Could not request local forwarding" in the ssh window).',
  '2. Open the link in the same browser, on the same computer as the tunnel.',
  '3. If Chrome asked about local network access, allow it.',
  '4. Ferretry may not be running on that machine, or its relay may be switched off there. Pairing from another device needs it running with the relay on (or an SSH tunnel).',
].join('\n');

const root = document.getElementById('root');
if (root === null) throw new Error('the scene page has no #root');
createRoot(root).render(
  <PairingScreen
    connections={[]}
    selectedDaemonId={null}
    arrival={{ kind: 'seed', seed: SEED }}
    onPair={async () => {
      throw new Error(MESSAGE);
    }}
    onRemove={() => {}}
    onSelect={() => {}}
  />,
);
