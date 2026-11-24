/**
 * The browser entry for the ONBOARDING "PERMISSIONS" STEP over fake data (no daemon): the REAL `createPermissionsPanel` (what the
 * setup flow mounts) drawn by the REAL `FlowPage` (cover, frame, progress, footer). The one fake is the client: the two harnesses
 * installed and their two config files, which `PUT` writes back so the page can be seen after Next.
 *
 *   ?theme=<family>-<mode>   the first look (the mode is read from it)
 *   ?claude=auto             Claude Code's file says Auto mode (the box starts unticked, "Change" open)
 *   ?only=codex              only Codex was picked in "Which AI"
 */
import { LivingBackground } from '@ferretry/app/ui';
import { WithDeviceTheme } from '@ferretry/app/testing/settings-shell';
import type { StepHost } from '@ferretry/kernel/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { FlowPage } from '../../../../app/features/setup-flow/page-frame.tsx';
import { createPermissionsPanel } from '../../../../app/features/permissions/permissions-panel.tsx';
import type { FlowStep } from '../../../../app/lib/index.ts';

const params = new URLSearchParams(window.location.search);
const first = params.get('theme') ?? 'studio-light';
document.documentElement.dataset.theme = first;
const only = params.get('only');

const files: Record<string, string> = {
  'harness-claude-code.yaml': `binary: /fake/bin/claude\npermissionMode: ${params.get('claude') === 'auto' ? 'auto' : 'skip'}\n`,
  'harness-codex.yaml': 'binary: /fake/bin/codex\npermissionMode: skip\n',
};
const writes: { path: string; text: string }[] = [];
(window as unknown as { __writes: typeof writes }).__writes = writes;

const client = {
  call: async (route: string, options?: { query?: { path: string }; body?: { path: string; text: string } }) => {
    if (route === 'GET /v1/onboarding')
      return {
        harnesses: [
          { key: 'claude-code', label: 'Claude Code' },
          { key: 'codex', label: 'Codex' },
        ],
      };
    if (route === 'GET /v1/config/file') {
      const path = options?.query?.path ?? '';
      return {
        path,
        text: files[path] ?? '',
        etag: 'e1',
        exists: true,
        state: 'ok',
        absolutePath: `/fake/config/${path}`,
      };
    }
    if (route === 'PUT /v1/config/file') {
      const body = options?.body as { path: string; text: string };
      files[body.path] = body.text;
      writes.push(body);
      return { path: body.path, etag: 'e2', outcome: 'applied' };
    }
    throw new Error(`unexpected route ${route}`);
  },
} as unknown as PluginClient;

const STEP: FlowStep = {
  key: 'onboarding.permissions',
  plugin: 'onboarding',
  id: 'permissions',
  title: 'Permissions',
  phase: 'daemon',
  order: 6,
  appliesTo: [],
  onlyOn: [],
  stepHost: true,
  state: 'pending',
};
// Page 3 of 20: the total is the full set of pages the answers imply, so it is the same on every page of the run.
const PROGRESS = {
  segments: Array.from({ length: 20 }, (_, index) => ({
    id: `page-${String(index)}`,
    label: index < 3 ? 'This machine' : index < 12 ? 'Claude Code' : index < 17 ? 'Codex' : 'This device',
  })),
  current: 'page-2',
  step: 3,
  of: 20,
  pages: true as const,
};
const noop = (): void => undefined;
const Panel = createPermissionsPanel(client);
const mode = first.endsWith('dark') ? 'dark' : 'light';
const memory =
  only === 'codex' ? { agentsOn: 'codex', agentsOff: 'claude-code' } : { agentsOn: 'claude-code,codex', agentsOff: '' };

function Scene(): ReactNode {
  return (
    <FlowPage
      step={STEP}
      daemon="fy_daemon_a"
      progress={PROGRESS}
      direction="forward"
      canBack
      segment={() => memory}
      remember={noop}
      onDone={noop}
      onSkip={noop}
      onNotNeeded={noop}
      onNext={noop}
      onBack={noop}
      onLater={noop}
      silenceMs={600_000}
      render={(host: StepHost) => <Panel step={{ ...host, segment: memory }} />}
    />
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
            <Scene />
          </WithDeviceTheme>
        </main>
      </div>
    </div>,
  );
