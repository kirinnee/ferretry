/**
 * The Kernel's app half, parity with today's Settings › Files, Doctor and Host checks (docs/design/rebuild-parity.tsv,
 * owner `kernel`, kind S). Each surface is proved by drawing it: the half the shell builds is mounted over a scripted
 * daemon client and the test reads what it drew.
 */
import { describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import { createElement, type FunctionComponent } from 'react';
import app from '../../../app/index.ts';
import { ConfigFilesPanel, configSummaryWords, groupWords } from '../../../app/config-files/panel.tsx';
import { doctorHeadline } from '../../../app/doctor/doctor-settings.tsx';
import { ConfigChanged, type DoctorReport } from '../../../contract/index.ts';
import type { SettingsProps } from '../../../manifest/index.ts';
import manifest from '../../../plugin.ts';
import { recordingClient, Refusal } from '../../support/app-client.ts';

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  });
};

const HOME = '/home/me/.ferretry/config';

const status = (over: Record<string, unknown> = {}) => ({
  directory: HOME,
  files: [
    { path: 'machine.yaml', kind: 'kernel', state: 'ok' },
    { path: 'logins/work.yaml', kind: 'logins', state: 'invalid' },
    { path: 'warden.yaml', kind: 'warden', state: 'pending' },
  ],
  issues: [
    {
      path: 'logins/work.yaml',
      line: 3,
      column: 5,
      severity: 'error',
      message: 'provider must be a name',
      fix: 'write a provider name',
    },
  ],
  pending: [{ path: 'warden.yaml', etag: 'e-w', changes: ['raises the daily spend cap'] }],
  checkedAt: '2026-11-14T10:00:00.000Z',
  ...over,
});

const doctor: DoctorReport = {
  checks: [
    {
      name: 'bash',
      requirement: 'required',
      status: 'present',
      summary: 'found on PATH at /usr/bin/bash',
      impact: 'Generated fleet wrappers cannot run.',
    },
    {
      name: 'codex',
      requirement: 'alternative',
      status: 'missing',
      summary: 'not found in the inherited environment, nor in PATH',
      impact: 'no codex session can start on this host',
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
  limitation: 'Resolving a program is all this report proves.',
};

/** One daemon that answers the kernel's own routes from the scripts given. */
const daemon = (script: Record<string, unknown> = {}) =>
  recordingClient(route => {
    if (route in script) return script[route];
    if (route === 'GET /v1/config/status') return status();
    if (route === 'GET /v1/doctor') return doctor;
    if (route === 'GET /v1/health') return { protocol: 5, version: '5.0.0' };
    if (route === 'GET /v1/config/file')
      return { path: 'warden.yaml', absolutePath: `${HOME}/warden.yaml`, exists: true, text: 'cap: 10\n', etag: 'e1' };
    return new Error(`no route ${route}`);
  });

const tab = (client: ReturnType<typeof daemon>['client'], id: string) => {
  const built = must(app.build?.({ manifest, client }), 'the built half');
  return must((built.settings as Readonly<Record<string, unknown>> | undefined)?.[id], `the ${id} settings tab`);
};

const shown = (client: ReturnType<typeof daemon>['client'], id: string) =>
  mount(createElement(tab(client, id) as FunctionComponent<SettingsProps>, {} as SettingsProps));

describe('the Kernel app half draws the surfaces today’s Settings had for configuration files and host checks', () => {
  it('S-0302 the Files feature is declared as the Files settings tab and the half builds a view for it', () => {
    const files = manifest.ui?.settings?.find(setting => setting.id === 'files');
    expect(files?.label).toBe('Files');
    expect(typeof tab(daemon().client, 'files')).toBe('function');
  });

  it('S-0478 the settings navigation lists Files (the configuration files) beside the host checks', () => {
    const ids = (manifest.ui?.settings ?? []).map(setting => setting.id).sort();
    expect(ids).toEqual(['doctor', 'files', 'host-checks']);
  });

  it('S-0479 S-0417 the Files tab is labelled Files and sits in the Advanced end of the tabs, after the host checks', () => {
    const settings = manifest.ui?.settings ?? [];
    const order = (id: string) => settings.find(setting => setting.id === id)?.order ?? 0;
    expect(order('files')).toBeGreaterThan(order('host-checks'));
    expect(order('host-checks')).toBeGreaterThan(order('doctor'));
  });

  it('S-0067 the panel says where the files are, what waits for the owner, what is wrong and every file by group', async () => {
    const view = await mount(
      createElement(ConfigFilesPanel, {
        view: status() as never,
        write: async () => undefined,
        confirming: {},
        onConfirm: () => undefined,
        onEdit: () => undefined,
      }),
    );
    const text = view.container.textContent ?? '';
    expect(text).toContain('These settings live in files on this machine');
    expect(text).toContain(HOME);
    expect(view.container.querySelector('[data-config-summary]')?.textContent).toBe(
      '3 files · 1 with errors · 1 waiting for you',
    );
    expect(view.container.querySelector('[data-config-pending="warden.yaml"]')?.textContent).toContain(
      'raises the daily spend cap',
    );
    expect(view.container.querySelector('[data-config-issue="error"]')?.textContent).toContain('logins/work.yaml:3:5');
    expect(
      view.container.querySelector('[data-config-file="logins/work.yaml"] [data-config-file-state]')?.textContent,
    ).toBe('Invalid — last good in effect');
    expect(view.container.querySelector('[data-config-group="logins"] h4')?.textContent).toBe('AI logins');
    expect(view.container.querySelector('[data-config-file="machine.yaml"]')?.textContent).toContain(
      `${HOME}/machine.yaml`,
    );
    expect(configSummaryWords(status() as never)).toBe('3 files · 1 with errors · 1 waiting for you');
    expect(groupWords('some-plugin')).toBe('Some plugin');
    await view.unmount();
  });

  it('S-0068 the surface reads the status, opens a file in the editor, saves against its etag and confirms a held edit', async () => {
    const written: unknown[] = [];
    const confirmed: unknown[] = [];
    const scripted = recordingClient((route, init) => {
      if (route === 'PUT /v1/config/file') {
        written.push(init?.body);
        return {
          path: 'warden.yaml',
          etag: 'e2',
          outcome: 'pending',
          pending: { path: 'warden.yaml', etag: 'e2', changes: ['raises the daily spend cap'] },
        };
      }
      if (route === 'POST /v1/config/confirm') {
        confirmed.push(init?.body);
        return { path: 'warden.yaml', confirmed: true };
      }
      return route === 'GET /v1/config/status'
        ? status()
        : { path: 'warden.yaml', absolutePath: `${HOME}/warden.yaml`, exists: true, text: 'cap: 10\n', etag: 'e1' };
    });
    const view = await shown(scripted.client, 'files');
    await settle();
    expect(scripted.calls[0]?.route).toBe('GET /v1/config/status');
    await interact(() =>
      must(view.container.querySelector<HTMLElement>('[data-config-edit="warden.yaml"]'), 'edit').click(),
    );
    await settle();
    expect(
      scripted.calls.some(call => call.route === 'GET /v1/config/file' && call.init?.query?.path === 'warden.yaml'),
    ).toBe(true);
    const editor = must(
      document.body.querySelector<HTMLTextAreaElement>('[data-config-editor-text]'),
      'the editor text',
    );
    expect(editor.value).toBe('cap: 10\n');
    expect(document.body.textContent).toContain('Never paste a key here');
    await interact(() => must(document.body.querySelector<HTMLElement>('[data-config-submit]'), 'save').click());
    await settle();
    expect(written).toEqual([{ path: 'warden.yaml', text: 'cap: 10\n', etag: 'e1' }]);
    expect(document.body.querySelector('[data-config-save="pending"]')?.textContent).toContain(
      'waiting for your confirmation',
    );
    await interact(() =>
      must(
        document.body.querySelector<HTMLElement>('[data-config-save="pending"] [data-config-confirm]'),
        'confirm',
      ).click(),
    );
    await settle();
    expect(confirmed).toEqual([{ path: 'warden.yaml', etag: 'e2' }]);
    expect(document.body.querySelector('[data-config-save="applied"]')?.textContent).toBe('In effect');
    await view.unmount();
  });

  it('S-0068 a file that moved under the editor is refused with Reload, and a status that cannot be read says so with Try again', async () => {
    const moved = recordingClient(route => {
      if (route === 'GET /v1/config/status') return status();
      if (route === 'PUT /v1/config/file') return new Refusal(412, 'config_conflict', 'changed');
      return { path: 'warden.yaml', exists: true, text: 'cap: 10\n', etag: 'e1' };
    });
    const view = await shown(moved.client, 'files');
    await settle();
    await interact(() =>
      must(view.container.querySelector<HTMLElement>('[data-config-edit="machine.yaml"]'), 'edit').click(),
    );
    await settle();
    await interact(() => must(document.body.querySelector<HTMLElement>('[data-config-submit]'), 'save').click());
    await settle();
    expect(document.body.querySelector('[data-config-save="conflict"]')?.textContent).toContain(
      'changed on the machine',
    );
    await view.unmount();

    const down = recordingClient(() => new Error('this machine did not answer'));
    const failed = await shown(down.client, 'files');
    await settle();
    expect(failed.container.querySelector('[data-config-files-failed]')?.textContent).toContain('could not be read');
    expect(failed.container.querySelector('[data-config-files-retry]')).not.toBeNull();
    await failed.unmount();
  });

  it('S-0068 the panel reads again when the kernel says a file moved', async () => {
    const live = daemon();
    const view = await shown(live.client, 'files');
    await settle();
    const before = live.calls.filter(call => call.route === 'GET /v1/config/status').length;
    await interact(() =>
      live.emit(ConfigChanged, { plugin: 'warden', path: 'warden.yaml', state: 'ok', etag: 'x' } as never),
    );
    await settle();
    expect(live.calls.filter(call => call.route === 'GET /v1/config/status').length).toBe(before + 1);
    await view.unmount();
  });

  it('S-0416 the Doctor tab draws the daemon’s host report: every check with its kind, what an absence breaks, and the limitation last', async () => {
    const view = await shown(daemon().client, 'doctor');
    await settle();
    const text = view.container.textContent ?? '';
    expect(doctorHeadline(doctor)).toBe('Required dependencies are present.');
    expect(view.container.querySelector('[data-doctor-headline]')?.textContent).toBe(
      'Required dependencies are present.',
    );
    expect(view.container.querySelector('[data-doctor-check="bash"]')?.getAttribute('data-doctor-status')).toBe(
      'present',
    );
    expect(view.container.querySelector('[data-doctor-check="codex"]')?.textContent).toContain('alternative');
    expect(view.container.querySelector('[data-doctor-check="codex"]')?.textContent).toContain(
      'no codex session can start on this host',
    );
    expect(view.container.querySelector('[data-doctor-check="launchctl"]')?.getAttribute('data-doctor-status')).toBe(
      'not_applicable',
    );
    expect(text.endsWith('Resolving a program is all this report proves.')).toBe(true);
    await view.unmount();
  });

  it('S-0416 a daemon that gives no report says so and does not read as healthy', async () => {
    const view = await shown(recordingClient(() => new Error('refused')).client, 'doctor');
    await settle();
    expect(view.container.textContent).toContain('Host checks unavailable');
    expect(view.container.textContent).toContain('No missing evidence is treated as a healthy host.');
    expect(view.container.textContent).not.toContain('Required dependencies are present.');
    await view.unmount();
  });

  it('S-0416 a missing required program says sessions will not work yet', () => {
    expect(doctorHeadline({ ...doctor, ready: false })).toBe(
      'A required dependency is missing; sessions will not work yet.',
    );
  });

  it('S-0114 S-0419 S-0488 the Host checks tab is Checking first, then Reachable only on a well-formed health answer', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const pending = new Promise<unknown>(resolve => {
      answer = resolve;
    });
    const live = daemon({ 'GET /v1/health': pending });
    const view = await shown(live.client, 'host-checks');
    await settle();
    expect(view.container.querySelector('[data-daemon-reachability]')?.getAttribute('data-daemon-reachability')).toBe(
      'checking',
    );
    answer({ protocol: 5, version: '5.0.0' });
    await settle();
    expect(view.container.querySelector('[data-daemon-reachability]')?.getAttribute('data-daemon-reachability')).toBe(
      'reachable',
    );
    expect(view.container.querySelector('[data-daemon-version]')?.textContent).toContain('5.0.0');
    expect(manifest.ui?.settings?.find(setting => setting.id === 'host-checks')?.label).toBe('Host checks');
    await view.unmount();
  });

  it('S-0114 a daemon that refuses, or answers with something that is not a health reading, is Unreachable, never optimistic', async () => {
    for (const answer of [new Error('timeout'), { nonsense: true }]) {
      const view = await shown(daemon({ 'GET /v1/health': answer }).client, 'host-checks');
      await settle();
      expect(view.container.querySelector('[data-daemon-reachability]')?.getAttribute('data-daemon-reachability')).toBe(
        'unreachable',
      );
      await view.unmount();
    }
  });
});
