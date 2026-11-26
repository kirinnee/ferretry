/**
 * The browser entry for the "Your daemons" page over FAKE data: the REAL `PairingScreen` listing one paired machine,
 * optionally under the REAL `DeviceRefusedNotice` (the banner a refused device sees above it).
 *
 *   ?theme=<family>-<mode>
 *   &back=1      the host gave the page a way back (Back), as `/pair` does when reached from Settings
 *   &refused=1   the machine no longer accepts this browser: the notice is drawn above the page
 *   &motion=reduced
 */
import { createRoot } from 'react-dom/client';
import { DeviceRefusedNotice } from '../../../../app/features/pairing/device-refused-notice.tsx';
import { PairingScreen } from '../../../../app/features/pairing/pairing-screen.tsx';
import { daemonConnection } from '../../../../app/shell-pairing.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
// `&style=<id>` draws the page in that look (its palette comes from `theme`); the legacy shim only maps the palette's own look.
if (params.get('style') !== null) document.documentElement.setAttribute('data-style', params.get('style') as string);
if (params.get('motion') === 'reduced') document.documentElement.dataset.motion = 'reduced';

const box = daemonConnection({
  daemonId: 'fy_daemon_box',
  baseUrl: 'https://box.example.test',
  deviceId: 'device-box',
  daemonName: 'Liftoff Box',
});

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div data-scene-ready="">
      {params.get('refused') === '1' ? <DeviceRefusedNotice machineName="Liftoff Box" onPairAgain={() => {}} /> : null}
      <PairingScreen
        connections={[{ ...box, pairedAt: 1, lastSelectedAt: 2 }]}
        selectedDaemonId={box.daemonId}
        scanHost={{ supported: true, scan: async () => await new Promise<string>(() => {}) }}
        onPair={async () => {}}
        onRemove={() => {}}
        onSelect={() => {}}
        {...(params.get('back') === '1' ? { onClose: () => {} } : {})}
      />
    </div>,
  );
