/**
 * Settings › Pack mode, MOUNTED AS THE SHELL MOUNTS IT (`createSettings(client)`) over a fixture daemon that answers the
 * kernel's configuration-file routes (`GET`/`PUT /v1/config/file`) and `GET /v1/pack`. Nothing here is a `ConfigFiles` double:
 * the page reads and saves `packs.yaml` through the real adapter, the real YAML editor and the real shell primitives.
 * No credential appears; the file names no secret.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { ComponentType } from 'react';
import type { SettingsProps } from '@ferretry/kernel/manifest';
import { createSettings } from '../../../app/views/pack-settings.tsx';
import type { PacksClient } from '../../../app/lib/client.ts';
import { type Mounted, mount, must } from '../support/dom.ts';
import { byText, click, textOf, typeInto, waitFor, waitForText } from '../support/learning-dom.ts';
import { PACK_VIEW } from '../support/pack.ts';

const MODELINE = '# yaml-language-server: $schema=schemas/packs.json';
const FILE = `${MODELINE}\n# Pack mode on this machine — my notes\nenabled: true\nlimits:\n  maxDepth: 2 # keep it shallow\n`;

const refusal = (status: number, code: string, message: string): Error =>
  Object.assign(new Error(message), { status, code, body: { error: message, code } });

interface Call {
  readonly route: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** One `packs.yaml` on a fixture machine: its text, its etag, and whether an edit is held for the owner. */
const fixtureDaemon = (options: { readonly holds?: (text: string) => string[]; readonly moved?: boolean } = {}) => {
  const calls: Call[] = [];
  let text = FILE;
  let etag = 'etag-1';
  const client = {
    call: async (route: string, init?: { query?: Readonly<Record<string, string>>; body?: unknown }) => {
      calls.push({ route, query: init?.query, body: init?.body });
      if (route === 'GET /v1/pack') return PACK_VIEW;
      if (route === 'GET /v1/config/file')
        return { path: init?.query?.path, exists: true, text, etag, absolutePath: '/home/fy/config/packs.yaml' };
      if (route === 'PUT /v1/config/file') {
        const body = init?.body as { path: string; text: string; etag: string };
        if (options.moved === true || body.etag !== etag)
          throw refusal(
            409,
            'config_conflict',
            'packs.yaml changed since it was read; read it again and redo the edit',
          );
        const held = options.holds?.(body.text) ?? [];
        text = body.text;
        etag = `etag-${String(calls.length)}`;
        return held.length === 0
          ? { path: body.path, etag, outcome: 'applied' }
          : { path: body.path, etag, outcome: 'pending', pending: { path: body.path, etag, changes: held } };
      }
      throw new Error(`no route ${route}`);
    },
  } as unknown as PacksClient;
  return { client, calls, text: () => text };
};

let shown: Mounted | undefined;
afterEach(async () => {
  await shown?.unmount();
  shown = undefined;
});

const open = async (client: PacksClient): Promise<HTMLElement> => {
  const Tab = createSettings(client) as unknown as ComponentType<SettingsProps>;
  shown = await mount(<Tab />);
  await waitForText(shown.container, 'Pack mode on this machine');
  return shown.container;
};
const puts = (calls: readonly Call[]) => calls.filter(call => call.route === 'PUT /v1/config/file');

describe('Settings › Pack mode over the kernel config routes', () => {
  it('shows every setting, not the "cannot read or save that file yet" placeholder', async () => {
    const root = await open(fixtureDaemon().client);
    const text = textOf(root);
    expect(text).not.toContain('cannot read or save');
    for (const label of [
      'Agent decides',
      'Jev decides',
      'Helpers for an interactive ferret',
      'Helpers for an unattended ferret',
      'Deepest nesting',
      'Probe timeout (seconds)',
      'Trust a passed probe for (seconds)',
    ])
      expect(text).toContain(label);
  });

  it('saves a tightening edit against the etag it read, keeping the owner’s comments, and it applies', async () => {
    const daemon = fixtureDaemon();
    const root = await open(daemon.client);
    await click(must(root.querySelector('[data-pack-switch]'), 'switch'));
    await waitFor(() => puts(daemon.calls).length === 1, 'the save');
    const [put] = puts(daemon.calls);
    expect(put?.body).toMatchObject({ path: 'packs.yaml', etag: 'etag-1' });
    expect(daemon.text()).toContain('# Pack mode on this machine — my notes');
    expect(daemon.text()).toContain('enabled: false');
    expect(daemon.text()).toContain('maxDepth: 2 # keep it shallow');
    expect(root.querySelector('[data-pack-outcome]') === null).toBe(true);
  });

  it('says a LOOSENING edit waits for the owner’s confirmation and never claims it applied', async () => {
    const daemon = fixtureDaemon({ holds: text => (text.includes('decision: jev') ? ['Jev decides the model'] : []) });
    const root = await open(daemon.client);
    const jev = must([...root.querySelectorAll<HTMLInputElement>('input[name="pack-decision"]')][1], 'jev');
    await click(jev);
    await waitForText(root, 'not in effect until you confirm it');
    expect(root.querySelector('[data-pack-outcome]')?.getAttribute('data-pack-outcome')).toBe('pending');
    expect(textOf(root)).toContain('Jev decides the model');
    expect(puts(daemon.calls)).toHaveLength(1);
    // Never auto-confirmed.
    expect(daemon.calls.some(call => call.route === 'POST /v1/config/confirm')).toBe(false);
  });

  it('refuses a stale etag with the daemon’s words and writes nothing', async () => {
    const daemon = fixtureDaemon({ moved: true });
    const root = await open(daemon.client);
    await typeInto(must(root.querySelector<HTMLInputElement>('[data-pack-number="maxDepth"]'), 'depth'), '3');
    await click(byText(root, 'button', 'Save limits'));
    await waitForText(root, 'changed since it was read');
    expect(root.querySelector('[data-pack-outcome]')?.getAttribute('data-pack-outcome')).toBe('refused');
    expect(daemon.text()).toBe(FILE);
  });
});
