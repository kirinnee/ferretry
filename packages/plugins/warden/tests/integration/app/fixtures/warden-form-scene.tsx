/** Settings › Warden's form over a FIXED FAKE config (no real login, key or machine), inside `.fy-page` like the real tab. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WardenSettingsForm } from '../../../../app/features/warden/warden-settings-form.tsx';
import { wardenFormErrors } from '../../../../app/features/warden/warden-settings-model.ts';
import { wardenConfig } from '../../../support/app/warden.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const state = params.get('state') ?? 'all';

const initial = wardenConfig({
  layers: { jev: state !== 'rules', llm: state !== 'rules' },
  autoMove: { ...wardenConfig().autoMove, enabled: state !== 'rules' },
  accounts: [{ agent: 'claude-a' }, { agent: 'codex-b' }],
});

function Scene() {
  const [value, setValue] = useState(initial);
  return (
    <main className="fy-page" style={{ padding: 16, maxWidth: 1100 }}>
      <WardenSettingsForm
        value={value}
        onChange={setValue}
        jevKey={{ state: 'set' }}
        errors={wardenFormErrors(value)}
      />
    </main>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
