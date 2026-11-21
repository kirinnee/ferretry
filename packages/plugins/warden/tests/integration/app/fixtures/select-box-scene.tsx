/**
 * The browser entry for "the Warden's lists are the app's own SelectBox" (r11 S3f), over fake data and the REAL components:
 *
 *   ?scene=ask      "Ask the Warden to investigate now": the real form, three foci. Its fake ports record the exact
 *                   `investigate` request on `window.__requests`
 *   ?scene=daemon   the Warden page's daemon filter over three fake machines; each choice is written to `data-chosen`
 *   &theme=<family>-<mode>
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AskWardenForm, type AskWardenPorts } from '../../../../app/features/warden/ask-warden.tsx';
import { WardenDaemonFilter } from '../../../../app/features/warden/warden-daemon-filter.tsx';
import { daemonConnection, type DaemonId } from '../../../../app/lib/machine.ts';
import type { WardenInvestigateRequest } from '../../../../app/wire.ts';
import { wardenConfig, wardenStatus } from '../../../support/app/warden.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('scene') ?? 'ask';

const requests: WardenInvestigateRequest[] = [];
(window as unknown as { __requests: WardenInvestigateRequest[] }).__requests = requests;

const ports: AskWardenPorts = {
  status: async () =>
    wardenStatus({ config: wardenConfig({ accounts: [{ agent: 'claude-default', model: 'opus' }] }) }),
  investigate: async request => {
    requests.push(request);
    return { ferret: request.ferret, state: 'queued', position: 1, message: 'Queued: 1 ahead.' };
  },
};

const MACHINES = [
  { connection: daemonConnection({ daemonId: 'daemon-ec2' }), name: 'Liftoff EC2' },
  { connection: daemonConnection({ daemonId: 'daemon-mbp' }), name: 'Liftoff MBP' },
  { connection: daemonConnection({ daemonId: 'daemon-nas' }), name: 'Home NAS' },
];

function Ask() {
  const [notice, setNotice] = useState('');
  return (
    <main style={{ padding: 16, maxWidth: 520 }}>
      <AskWardenForm
        host={{ close: () => undefined, open: () => undefined, notify: setNotice, compact: false }}
        name="hadi"
        ports={ports}
        ferret="sess-1"
      />
      <p data-notice="">{notice}</p>
    </main>
  );
}

function Daemon() {
  const [selected, setSelected] = useState<DaemonId | null>(null);
  return (
    <main style={{ padding: 16, maxWidth: 520 }}>
      <WardenDaemonFilter machines={MACHINES} selected={selected} onChoose={setSelected} />
      <p data-chosen="">{selected ?? 'all'}</p>
    </main>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(scene === 'daemon' ? <Daemon /> : <Ask />);
