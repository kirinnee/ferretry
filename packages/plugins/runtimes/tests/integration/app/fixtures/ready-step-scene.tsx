/**
 * The browser entry for the "<TOOL> IS READY" PAGE (O9-6) over fake data (no daemon): the REAL shared `RuntimeReadyPage`
 * (this plugin's import kit, what Claude Code's and Codex's segments end with) inside the shell's own `StepPageFrame` (title and
 * footer). The one fake is the client, whose `GET /v1/runtimes` answers what `?state=` says.
 *
 *   ?theme=<family>-<mode>                     the first look (the mode is read from it)
 *   ?tool=claude-code|codex                    which tool's page (default claude-code)
 *   ?state=ready|many|none|blocked|unread      what the machine says about that tool's runtimes (default ready)
 */
import { StepPageFrame } from '@ferretry/app';
import { LivingBackground } from '@ferretry/app/ui';
import { WithDeviceTheme } from '@ferretry/app/testing/settings-shell';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { RuntimeReadyPage } from '../../../../app/features/import-kit/index.ts';

const params = new URLSearchParams(window.location.search);
const first = params.get('theme') ?? 'studio-light';
document.documentElement.dataset.theme = first;
const tool = params.get('tool') === 'codex' ? 'codex' : 'claude-code';
const label = tool === 'codex' ? 'Codex' : 'Claude Code';
const state = params.get('state') ?? 'ready';

const row = (name: string, available = true) => ({
  id: name,
  name,
  harness: tool,
  credential: { id: name, store: 'host' },
  launch: available ? { available: true } : { available: false, reason: 'Sign in to launch.' },
});

const client = {
  call: async (route: string) => {
    if (route !== 'GET /v1/runtimes') throw new Error(`unexpected route ${route}`);
    if (state === 'unread') throw new Error('unreachable');
    if (state === 'none') return { runtimes: [] };
    if (state === 'blocked') return { runtimes: [row(`${label} (work)`, false)] };
    if (state === 'many') return { runtimes: [row(`${label} (personal)`), row(`${label} (work)`)] };
    return { runtimes: [row(`${label} (your terminal sign-in)`)] };
  },
} as unknown as PluginClient;

const noop = (): void => undefined;
const mode = first.endsWith('dark') ? 'dark' : 'light';

function Page(): ReactNode {
  return (
    <StepPageFrame
      title="Your runtime"
      back={{ onClick: noop }}
      later={{ onClick: noop }}
      next={{ label: 'Next', onClick: noop }}
    >
      <RuntimeReadyPage client={client} harness={tool} label={label} />
    </StepPageFrame>
  );
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="fy-sf-root" data-scene-ready="">
      <LivingBackground />
      <div style={{ bottom: 0, display: 'flex', left: 0, position: 'fixed', right: 0, top: 0 }} data-scene-frame="">
        <main
          style={{ flex: 1, minHeight: 0, minWidth: 0, overflowY: 'auto', position: 'relative' }}
          data-scene-main=""
        >
          <WithDeviceTheme mode={mode}>
            <Page />
          </WithDeviceTheme>
        </main>
      </div>
    </div>,
  );
