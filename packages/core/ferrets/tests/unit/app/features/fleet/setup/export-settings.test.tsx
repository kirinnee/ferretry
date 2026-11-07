import { afterEach, describe, expect, it } from 'bun:test';
import { secretReference } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { ReactElement } from 'react';
import type { FleetClientFactory } from '../../../../../src/features/fleet/fleet-client.ts';
import { downloadFile, ExportSettings } from '../../../../../src/features/fleet/setup/export-settings.tsx';
import { interact, type Mounted, mount, must } from '../../../../support/dom.ts';
import { type Call, STUDIO, scriptedClient } from './setup-support.ts';

const mounts: Mounted[] = [];
afterEach(async () => {
  for (const view of mounts.splice(0)) await view.unmount();
});

const show = async (element: ReactElement): Promise<Mounted> => {
  const view = await mount(element);
  mounts.push(view);
  return view;
};

const q = (view: Mounted, selector: string): Element | null => view.container.querySelector(selector);
const text = (view: Mounted): string => view.container.textContent ?? '';

const WHEN = new Date('2026-10-16T09:30:00.000Z');
const NAME = 'ferretry-settings-studio-mac-2026-10-16.zip';

const summary = (path: string, kind: string, state: 'ok' | 'pending' | 'invalid') => ({
  path,
  kind,
  schema: kind,
  state,
});

const STATUS = {
  directory: '/home/you/.ferretry/config',
  files: [
    summary('machine.yaml', 'machine', 'ok'),
    summary('warden.yaml', 'warden', 'pending'),
    summary('voice.yaml', 'voice', 'invalid'),
  ],
  issues: [],
  pending: [],
  checkedAt: '2026-10-16T09:00:00.000Z',
};

const fileView = (path: string, kind: string, body: string) => ({
  path,
  absolutePath: `/home/you/.ferretry/config/${path}`,
  kind,
  schema: kind,
  exists: true,
  text: body,
  etag: `etag-${path}`,
  state: 'ok',
  issues: [],
});

const ANSWERS = {
  '/v1/config/status': STATUS,
  '/v1/config/file?path=machine.yaml': fileView('machine.yaml', 'machine', 'agentPermissions: auto\n'),
  '/v1/config/file?path=warden.yaml': fileView('warden.yaml', 'warden', 'triage: jev\n'),
};

interface Saved {
  readonly name: string;
  readonly bytes: Uint8Array;
}

const harness = (answers: Record<string, unknown> = ANSWERS) => {
  const calls: Call[] = [];
  const saved: Saved[] = [];
  const createClient: FleetClientFactory = async () => scriptedClient(answers, calls);
  return { calls, saved, createClient };
};

const props = (h: ReturnType<typeof harness>) => ({
  connection: STUDIO,
  machineName: 'studio-mac',
  createClient: h.createClient,
  save: (name: string, bytes: Uint8Array) => {
    h.saved.push({ name, bytes });
  },
  now: () => WHEN,
});

const clickExport = async (view: Mounted): Promise<void> => {
  await interact(() => (must(q(view, '[data-export-run]'), 'export button') as HTMLElement).click());
};

describe('ExportSettings', () => {
  it('starts idle with the Export button and says what the zip holds', async () => {
    const h = harness();
    const view = await show(<ExportSettings {...props(h)} />);
    const run = must(q(view, '[data-export-run]'), 'run') as HTMLButtonElement;
    expect(run.textContent).toBe('Export settings');
    expect(run.disabled).toBe(false);
    expect(text(view)).toContain('without secrets');
    expect(q(view, '[data-export-back]')).toBeNull();
    expect(q(view, '[data-setup-note]')).toBeNull();
    expect(h.calls).toEqual([]);
  });

  it('reads the status, then each included file, and hands one dated zip to save', async () => {
    const h = harness();
    const view = await show(<ExportSettings {...props(h)} />);
    await clickExport(view);

    expect(h.calls.map(call => call.path)).toEqual([
      '/v1/config/status',
      '/v1/config/file?path=machine.yaml',
      '/v1/config/file?path=warden.yaml',
    ]);
    expect(h.saved).toHaveLength(1);
    const [zip] = h.saved as [Saved];
    expect(zip.name).toBe(NAME);
    expect(zip.bytes).toBeInstanceOf(Uint8Array);
    const raw = new TextDecoder().decode(zip.bytes);
    expect(raw).toContain('config/machine.yaml');
    expect(raw).toContain('agentPermissions: auto');
    expect(raw).toContain('config/warden.yaml');
    expect(raw).not.toContain('voice.yaml');

    expect(must(q(view, '[data-setup-note="export-saved"]'), 'saved').textContent).toContain(`Saved ${NAME}`);
    expect(must(q(view, '[data-setup-note="export-saved"]'), 'saved').textContent).toContain('2 files. Secrets: none.');
    const manifest = must(q(view, '[data-setup-section="export-manifest"] pre'), 'manifest').textContent;
    expect(manifest).toBe(
      [
        NAME,
        '  config/machine.yaml',
        '  config/warden.yaml',
        `  # secrets: none (only ${secretReference('NAME')} references)`,
      ].join('\n'),
    );
    expect(q(view, '[data-setup-note="export-failed"]')).toBeNull();
  });

  it('names the file it left out, with the reason, and never reads it', async () => {
    const h = harness();
    const view = await show(<ExportSettings {...props(h)} />);
    await clickExport(view);

    const note = must(q(view, '[data-setup-note="export-left-out"]'), 'left out');
    expect(note.textContent).toContain('1 file left out');
    expect(note.textContent).toContain('voice.yaml');
    expect(note.textContent).toContain('an invalid file can hold a pasted secret');
    expect(h.calls.some(call => call.path.includes('voice.yaml'))).toBe(false);
  });

  it('shows no left-out note when every file checks', async () => {
    const h = harness({
      ...ANSWERS,
      '/v1/config/status': { ...STATUS, files: STATUS.files.slice(0, 2) },
    });
    const view = await show(<ExportSettings {...props(h)} />);
    await clickExport(view);
    expect(q(view, '[data-setup-note="export-saved"]')).not.toBeNull();
    expect(q(view, '[data-setup-note="export-left-out"]')).toBeNull();
  });

  it('says it is reading and disables the button until the files are in', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => (release = resolve));
    const h = harness();
    const view = await show(
      <ExportSettings
        {...props(h)}
        createClient={async connection => {
          await gate;
          return h.createClient(connection);
        }}
      />,
    );
    await clickExport(view);
    const run = must(q(view, '[data-export-run]'), 'run') as HTMLButtonElement;
    expect(run.textContent).toBe('Reading the files…');
    expect(run.disabled).toBe(true);
    expect(h.saved).toHaveLength(0);

    await interact(() => release());
    expect(run.textContent).toBe('Export settings');
    expect(run.disabled).toBe(false);
    expect(h.saved).toHaveLength(1);
  });

  it('says Couldn’t export with the machine’s sentence when it refuses, and saves nothing', async () => {
    const h = harness({
      ...ANSWERS,
      '/v1/config/file?path=warden.yaml': new FyHttpError('A passkey is needed to read this file.', 403, 'step_up'),
    });
    const view = await show(<ExportSettings {...props(h)} />);
    await clickExport(view);

    const note = must(q(view, '[data-setup-note="export-failed"]'), 'failed');
    expect(note.textContent).toContain('Couldn’t export');
    expect(note.textContent).toContain('A passkey is needed to read this file.');
    expect(h.saved).toHaveLength(0);
    expect(q(view, '[data-setup-note="export-saved"]')).toBeNull();
    expect((must(q(view, '[data-export-run]'), 'run') as HTMLButtonElement).disabled).toBe(false);
  });

  it('says Couldn’t export when the machine cannot be reached at all', async () => {
    const h = harness({});
    const view = await show(<ExportSettings {...props(h)} />);
    await clickExport(view);
    expect(must(q(view, '[data-setup-note="export-failed"]'), 'failed').textContent).toContain('Couldn’t export');
    expect(h.saved).toHaveLength(0);
  });

  it('clears an earlier failure when the next export works', async () => {
    let broken = true;
    const h = harness();
    const view = await show(
      <ExportSettings
        {...props(h)}
        createClient={async connection => {
          if (broken) throw new FyHttpError('This machine is asleep.', 503, undefined);
          return h.createClient(connection);
        }}
      />,
    );
    await clickExport(view);
    expect(must(q(view, '[data-setup-note="export-failed"]'), 'failed').textContent).toContain(
      'This machine is asleep.',
    );
    broken = false;
    await clickExport(view);
    expect(q(view, '[data-setup-note="export-failed"]')).toBeNull();
    expect(q(view, '[data-setup-note="export-saved"]')).not.toBeNull();
  });

  it('renders a back button that leaves when given onLeave', async () => {
    let left = 0;
    const view = await show(<ExportSettings {...props(harness())} onLeave={() => (left += 1)} />);
    const back = must(q(view, '[data-export-back]'), 'back');
    expect(back.textContent).toContain('Machine');
    await interact(() => (back as HTMLElement).click());
    expect(left).toBe(1);
  });

  it('names the zip from the real clock when no clock is injected', async () => {
    const h = harness();
    const { now: _now, ...rest } = props(h);
    const view = await show(<ExportSettings {...rest} />);
    await clickExport(view);
    expect((h.saved[0] as Saved).name).toMatch(/^ferretry-settings-studio-mac-\d{4}-\d{2}-\d{2}\.zip$/u);
  });
});

describe('downloadFile', () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalCreateElement = document.createElement.bind(document);
  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    document.createElement = originalCreateElement;
  });

  it('clicks one link carrying the file name over an object URL, then lets the URL go', () => {
    const events: string[] = [];
    let blob: Blob | undefined;
    URL.createObjectURL = (object: Blob | MediaSource) => {
      blob = object as Blob;
      events.push('create');
      return 'blob:https://pwa.example.test/zip-1';
    };
    URL.revokeObjectURL = (url: string) => {
      events.push(`revoke ${url}`);
    };
    const links: HTMLAnchorElement[] = [];
    document.createElement = ((tag: string) => {
      const element = originalCreateElement(tag);
      if (tag === 'a') {
        const link = element as HTMLAnchorElement;
        link.click = () => {
          events.push(`click ${link.download} ${link.href}`);
        };
        links.push(link);
      }
      return element;
    }) as typeof document.createElement;

    downloadFile(NAME, new Uint8Array([1, 2, 3]));

    expect(links).toHaveLength(1);
    expect(events).toEqual([
      'create',
      `click ${NAME} blob:https://pwa.example.test/zip-1`,
      'revoke blob:https://pwa.example.test/zip-1',
    ]);
    expect(blob?.type).toBe('application/zip');
    expect(blob?.size).toBe(3);
  });

  it('is what Export uses when no save is injected', async () => {
    const created: unknown[] = [];
    URL.createObjectURL = (object: Blob | MediaSource) => {
      created.push(object);
      return 'blob:https://pwa.example.test/zip-2';
    };
    URL.revokeObjectURL = () => undefined;
    const clicked: string[] = [];
    document.createElement = ((tag: string) => {
      const element = originalCreateElement(tag);
      if (tag === 'a')
        (element as HTMLAnchorElement).click = () => void clicked.push((element as HTMLAnchorElement).download);
      return element;
    }) as typeof document.createElement;

    const h = harness();
    const { save: _save, ...rest } = props(h);
    const view = await show(<ExportSettings {...rest} />);
    await clickExport(view);

    expect(clicked).toEqual([NAME]);
    expect(created).toHaveLength(1);
    expect(q(view, '[data-setup-note="export-saved"]')).not.toBeNull();
  });
});
