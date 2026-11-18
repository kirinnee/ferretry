/**
 * The browser entry for the pair page with its mascot and night sky, over fake data: the REAL `PairingScreen`.
 * No daemon, no real code: the seed is a fixed fake, and the daemon is on the relay path (its link carries a loopback
 * address that means nothing on this device), so the screen says "through the relay" and shows no `127.0.0.1`.
 *
 *   ?theme=<family>-<mode>
 *   &arrival=link|cold|broken   a pairing link (default), a cold open, or a link whose redemption fails
 *   &offer=open                the machine says the first-passkey window is open (7 minutes left): the success screen offers
 *                              "Add a passkey now" and waits for "Not now"
 *   &motion=reduced             the app's own Motion = Reduced (`<html data-motion="reduced">`)
 */

import { createRoot } from 'react-dom/client';
import { PairingScreen } from '../../../../app/features/pairing/pairing-screen.tsx';
import type { StepUpClient } from '../../../../app/lib/step-up-client.ts';
import { daemonConnection } from '../../../../app/shell-pairing.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
if (params.get('motion') === 'reduced') document.documentElement.dataset.motion = 'reduced';

const SEED = { daemonUrl: 'http://127.0.0.1:7617', daemonId: 'fy_daemon_9k3q2m7x4n8v1b6c5z0wd2f8', code: 'FAKE-0000' };
const arrival = params.get('arrival') ?? 'link';

// A machine whose first-passkey window closes in seven minutes (fake clock, fake view).
const OFFER_NOW = Date.parse('2026-11-17T10:00:00.000Z');
const openWindow: StepUpClient = {
  request: async <T,>(_path: string, schema: { parse: (value: unknown) => T }): Promise<T> =>
    schema.parse({ passkeys: [], registration: 'first-window', registrationClosesAt: '2026-11-17T10:07:00.000Z' }),
};
const offering = params.get('offer') === 'open';

const root = document.getElementById('root');
if (root === null) throw new Error('the scene page has no #root');
createRoot(root).render(
  <PairingScreen
    connections={[]}
    selectedDaemonId={null}
    arrival={arrival === 'cold' ? { kind: 'none' } : { kind: 'seed', seed: SEED }}
    sameMachine={false}
    defaultName={() => 'Chrome on Linux · 4f2a'}
    onPair={async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      if (arrival === 'broken') throw new Error('Nothing reached that daemon.');
      return {
        machine: 'kirin-workstation',
        via: 'relay' as const,
        connection: daemonConnection({
          daemonId: SEED.daemonId,
          baseUrl: SEED.daemonUrl,
          deviceId: 'fy_device_id_fake',
        }),
      };
    }}
    {...(offering
      ? {
          passkeyClient: async () => openWindow,
          passkeyOffer: { now: () => OFFER_NOW, supported: () => true, origin: () => 'https://ferretry.example' },
          onContinue: () => {},
        }
      : {})}
    onRemove={() => {}}
    onSelect={() => {}}
  />,
);
