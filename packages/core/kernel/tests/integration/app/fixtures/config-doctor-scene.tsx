/**
 * The browser entry for the Kernel's Settings views over FAKE data (no daemon, no secret, no real path):
 *
 *   ?theme=<family>-<mode>
 *   ?view=files | editor | files-empty | doctor | doctor-down | host-checks
 */
import { createRoot } from 'react-dom/client';
import { ConfigFilesPanel } from '../../../../app/config-files/panel.tsx';
import { ConfigFileEditor } from '../../../../app/config-files/editor.tsx';
import { DoctorReportView } from '../../../../app/doctor/doctor-settings.tsx';
import { HostChecksView } from '../../../../app/doctor/host-checks.tsx';
import type { DoctorReport } from '../../../../contract/index.ts';
import type { KernelClient } from '../../../../app/lib/client.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const view = params.get('view') ?? 'files';

const HOME = '/home/demo/.ferretry/config';
const status = {
  directory: HOME,
  files: [
    { path: 'machine.yaml', kind: 'kernel', state: 'ok' },
    { path: 'logins/work.yaml', kind: 'logins', state: 'invalid' },
    { path: 'logins/personal.yaml', kind: 'logins', state: 'ok' },
    { path: 'runtimes/main.yaml', kind: 'runtimes', state: 'ok' },
    { path: 'warden.yaml', kind: 'warden', state: 'pending' },
    { path: 'components/mcp/github-with-a-very-long-name-for-the-phone.yaml', kind: 'mcp', state: 'ok' },
  ],
  issues: [
    {
      path: 'logins/work.yaml',
      line: 3,
      column: 5,
      severity: 'error',
      message: 'provider must be one of the names under providers',
      fix: 'write a provider name, or remove the line to use the default',
    },
    { path: 'machine.yaml', severity: 'warning', message: 'a key this version does not know', fix: 'remove the line' },
  ],
  pending: [{ path: 'warden.yaml', etag: 'e-w', changes: ['raises the daily spend cap', 'turns auto-resume on'] }],
  checkedAt: '2026-11-14T10:00:00.000Z',
} as const;

const report: DoctorReport = {
  checks: [
    {
      name: 'tmux',
      requirement: 'required',
      status: 'present',
      summary: 'found on PATH at /opt/homebrew/Cellar/tmux/3.6a/bin/tmux',
      impact: 'Sessions cannot start or be managed.',
    },
    {
      name: 'bash',
      requirement: 'required',
      status: 'present',
      summary: 'found on PATH at /bin/bash',
      impact: 'Generated fleet wrappers cannot run.',
    },
    {
      name: 'claude',
      requirement: 'alternative',
      status: 'present',
      summary: '/home/demo/.local/bin/claude  (inherited environment — PATH)',
      impact:
        'A wrapper the fleet publishes for a claude account runs `claude`, so no claude session can start on this host. Accounts on the other harness are unaffected.',
    },
    {
      name: 'codex',
      requirement: 'alternative',
      status: 'missing',
      summary: 'not found in the inherited environment, and no extra search path is declared',
      impact:
        'A wrapper the fleet publishes for a codex account runs `codex`, so no codex session can start on this host. Accounts on the other harness are unaffected.',
    },
    {
      name: 'gh',
      requirement: 'optional',
      status: 'missing',
      summary: 'not found on PATH',
      impact:
        "The board's GitHub watcher cannot read PR state, link PRs or find releases; cards keep their PR state unknown.",
    },
    {
      name: 'launchctl',
      requirement: 'capability',
      status: 'not_applicable',
      summary: 'not used on this operating system',
      impact: 'This service manager is not used on this operating system.',
    },
  ],
  harnesses: [],
  ready: true,
  limitation:
    'Resolving a program and stating that this host could run it is all this report proves — it does not prove a harness is signed in, has credit, or can reach its provider.',
};

const fileClient: KernelClient = {
  call: async <Answer,>(): Promise<Answer> =>
    ({
      path: 'warden.yaml',
      absolutePath: `${HOME}/warden.yaml`,
      exists: true,
      text: '# yaml-language-server: $schema=.schema/warden.json\nenabled: true\ndailyCap: 40\nautoResume: true\n',
      etag: 'e1',
      issues: [],
    }) as Answer,
};

function Scene() {
  switch (view) {
    case 'editor':
      return (
        <>
          <ConfigFilesPanel
            view={status as never}
            write={async () => undefined}
            confirming={{}}
            onConfirm={() => undefined}
            onEdit={() => undefined}
          />
          <ConfigFileEditor
            client={fileClient}
            path="warden.yaml"
            onClose={() => undefined}
            onChanged={() => undefined}
          />
        </>
      );
    case 'files-empty':
      return (
        <ConfigFilesPanel
          view={{ ...status, files: [], issues: [], pending: [] } as never}
          write={async () => undefined}
          confirming={{}}
          onConfirm={() => undefined}
          onEdit={() => undefined}
        />
      );
    case 'doctor':
      return <DoctorReportView report={report} />;
    case 'doctor-down':
      return (
        <DoctorReportView
          report={{
            ...report,
            ready: false,
            checks: report.checks.map(check =>
              check.name === 'tmux' ? { ...check, status: 'missing' as const, summary: 'not found on PATH' } : check,
            ),
          }}
        />
      );
    case 'host-checks':
      return (
        <HostChecksView
          value="reachable"
          refreshing={false}
          refresh={() => undefined}
          version="5.0.0"
          protocol={5}
          fingerprint="fy_daemon_LhGT7RTh8wRuBminOE2wLDWDga0Nj57qdemo"
        />
      );
    default:
      return (
        <ConfigFilesPanel
          view={status as never}
          write={async () => undefined}
          confirming={{}}
          onConfirm={() => undefined}
          onEdit={() => undefined}
        />
      );
  }
}

const root = document.getElementById('root');
if (root === null) throw new Error('no #root');
createRoot(root).render(
  <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4" data-scene-ready="">
    <Scene />
  </div>,
);
