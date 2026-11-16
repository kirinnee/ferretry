/** The Warden settings (and the setup step that draws them) while the daemon holds the read for a passkey. Fake data. */
import { createRoot } from 'react-dom/client';
import { WardenConfigSurface } from '../../../../app/features/warden/warden-config-card.tsx';
import { daemonConnection } from '../../../../app/lib/machine.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const never = () => new Promise<never>(() => undefined);
const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <main style={{ padding: 16 }}>
      <h1>Setup</h1>
      <WardenConfigSurface
        connection={daemonConnection({ daemonId: 'ws' })}
        createClient={never}
        unavailable="message"
      />
    </main>,
  );
