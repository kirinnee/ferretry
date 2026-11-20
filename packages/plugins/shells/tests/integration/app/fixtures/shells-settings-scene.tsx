/**
 * The browser entry for the Shells Settings tab, over fake data: the REAL tab, three shells (two built, one not built, the
 * wider badge) and the Add form. The tab sits in a box as wide as Settings' panel is at that window (`?panel=<px>`).
 *
 *   ?theme=<family>-<mode>   ?panel=<px> (default 724)
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { createRoot } from 'react-dom/client';
import { createShellsSettings } from '../../../../app/views/shells-settings.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-dark';
const panel = Number(params.get('panel') ?? '724');

const HASH = `sha256-${'A'.repeat(43)}=`;
const shell = (
  name: string,
  kind: 'flake' | 'packages',
  build: 'built' | 'not-built',
  usedBy: readonly string[],
  description: string,
  floating = false,
) => ({ name, kind, locked: true, floating, narHash: HASH, build, usedBy, description });

const answers: Readonly<Record<string, unknown>> = {
  'GET /v1/shells/nix': { present: true, version: '2.24.0', path: '/nix/bin/nix' },
  'GET /v1/shells': {
    shells: [
      shell('default', 'packages', 'built', ['claude-default', 'codex-default'], 'Everyday tools for every ferret.'),
      shell('web', 'flake', 'built', ['sample-app'], 'Node, bun and a browser for web work.'),
      shell('rust-lab', 'flake', 'not-built', [], 'A Rust toolchain from a moving branch.', true),
    ],
  },
};

const client = {
  call: async (route: string) => {
    if (!(route in answers)) throw new Error(`no answer for ${route}`);
    return answers[route];
  },
  subscribe: () => () => undefined,
} as unknown as PluginClient;

const ShellsSettings = createShellsSettings(client);
createRoot(document.getElementById('root') as HTMLElement).render(
  <div style={{ width: panel, maxWidth: '100%', margin: '0 auto', padding: '0 16px', boxSizing: 'border-box' }}>
    <ShellsSettings />
  </div>,
);
