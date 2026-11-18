/**
 * The browser entry for the pair screen over FAKE data (no daemon, no pairing code, no real address): the REAL
 * `PairingScreen` listing two machines already paired, one under the name its owner gave it.
 *
 *   ?theme=<family>-<mode>
 */
import { createRoot } from 'react-dom/client';
import { PairingScreen } from '../../../../app/features/pairing/pairing-screen.tsx';
import { daemonConnection } from '../../../../app/shell-pairing.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const pebox = daemonConnection({
  daemonId: 'fy_daemon_pebox',
  baseUrl: 'https://pebox.example.test',
  deviceId: 'device-pebox',
  daemonName: 'pebox',
});
const laptop = daemonConnection({
  daemonId: 'fy_daemon_laptop',
  baseUrl: 'https://laptop.example.test',
  deviceId: 'device-laptop',
  daemonName: 'kirin-laptop',
});

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="mx-auto max-w-[640px] p-4" data-scene-ready="">
      <PairingScreen
        connections={[
          { ...pebox, pairedAt: 1, lastSelectedAt: 2 },
          { ...laptop, pairedAt: 1, lastSelectedAt: 1 },
        ]}
        selectedDaemonId={pebox.daemonId}
        scanHost={{ supported: true, scan: async () => await new Promise<string>(() => {}) }}
        onPair={async () => {}}
        onRemove={() => {}}
        onSelect={() => {}}
      />
    </div>,
  );
