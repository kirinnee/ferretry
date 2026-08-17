import { describe, expect, it } from 'bun:test';
import type { DoctorReport } from '@ferretry/protocol';

import { DoctorSettings } from '../../../../src/features/settings/doctor-settings.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { render, runAsync } from '../../../support/react.ts';

const connection = (id: string) =>
  daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceToken: `token-${id}` });

const report: DoctorReport = {
  ready: false,
  harnesses: [
    { kind: 'claude', launchable: ['claude-auto-loge'], blocked: [] },
    { kind: 'codex', launchable: [], blocked: ['codex-auto-terra: not on PATH'] },
  ],
  checks: [
    // The two the panel's own promise — "programs this daemon host needs, and what each absence breaks" —
    // is really about. The daemon resolves them, so the summary carries WHERE, not just whether.
    {
      name: 'claude',
      requirement: 'alternative',
      status: 'present',
      summary: 'found on PATH at /opt/homebrew/bin/claude',
      impact: 'A wrapper this fleet publishes for a Claude account runs `claude`.',
    },
    {
      name: 'codex',
      requirement: 'alternative',
      status: 'missing',
      summary: 'not found on PATH',
      impact: 'no Codex session can start here. Claude accounts are unaffected.',
    },
    { name: 'tmux', requirement: 'required', status: 'present', summary: 'on PATH', impact: 'sessions can start' },
    { name: 'bash', requirement: 'required', status: 'missing', summary: 'not found', impact: 'sessions cannot start' },
    {
      name: 'launchctl',
      requirement: 'capability',
      status: 'not_applicable',
      summary: 'Linux host',
      impact: 'systemd is used instead',
    },
    {
      name: 'browser login',
      requirement: 'optional',
      status: 'unavailable_by_design',
      summary: 'not offered',
      impact: 'no host capability is inferred',
    },
  ],
  limitation: 'PATH presence is all this report proves.',
};

describe('DoctorSettings', () => {
  it('fails closed while waiting, then renders every reported host verdict for its daemon', async () => {
    let release: ((next: DoctorReport) => void) | undefined;
    const renderer = render(
      <DoctorSettings
        connection={connection('alpha')}
        read={() =>
          new Promise<DoctorReport>(resolve => {
            release = resolve;
          })
        }
      />,
    );

    expect(JSON.stringify(renderer.toJSON())).toContain('Host checks unavailable');
    await runAsync(async () => {
      if (release === undefined) throw new Error('the doctor report was not requested');
      release(report);
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = JSON.stringify(renderer.toJSON());
    expect(renderer.root.findByProps({ 'data-doctor-daemon': 'alpha' })).toBeDefined();
    expect(text).toContain('A required dependency is missing; sessions will not work yet.');
    expect(text).toContain('Claude is the preferred ready harness.');
    expect(text).toContain('tmux');
    expect(text).toContain('bash');
    expect(text).toContain('launchctl');
    expect(text).toContain('browser login');
    expect(text).toContain(report.limitation);
    // WHERE each harness is, and what its absence breaks — the two things the owner asked Doctor for.
    expect(text).toContain('/opt/homebrew/bin/claude');
    expect(text).toContain('no Codex session can start here');
    // A path is one unbreakable token: at 390px an unbroken one takes the whole page sideways.
    expect(text).toContain('break-words');
  });

  it('keeps the unavailable state when the selected daemon refuses the report', async () => {
    const renderer = render(
      <DoctorSettings connection={connection('beta')} read={async () => Promise.reject(new Error('offline'))} />,
    );

    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(JSON.stringify(renderer.toJSON())).toContain('No missing evidence is treated as a healthy host.');
  });
});
