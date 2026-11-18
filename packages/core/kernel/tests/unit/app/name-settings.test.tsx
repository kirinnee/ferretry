/**
 * Settings › General › Name, drawn over a scripted daemon: the form reads the name and where it comes from, saves it
 * through the configuration-file routes, refuses what the daemon would refuse before it asks, and clears back to the
 * host name.
 */
import { describe, expect, it } from 'bun:test';
import { interact, mount, must } from '@ferretry/app/testing';
import { createElement } from 'react';
import { hostFileText, NameSettings, NameSettingsView } from '../../../app/name-settings.tsx';
import { recordingClient } from '../../support/app-client.ts';

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  });
};

/** A daemon that keeps `host.yaml` the way the real one does, and names the machine from it. */
function namedDaemon(initial?: string) {
  let text = initial;
  return recordingClient((route, init) => {
    if (route === 'GET /v1/plugins')
      return {
        protocol: 1,
        daemonName: text === undefined ? 'pebox-hostname' : (JSON.parse(text.slice(6)) as string),
        plugins: [],
      };
    if (route === 'GET /v1/config/file')
      return { path: 'host.yaml', exists: text !== undefined, text: text ?? '', etag: `e${String(text?.length ?? 0)}` };
    if (route === 'PUT /v1/config/file') {
      text = (init?.body as { readonly text: string } | undefined)?.text ?? '';
      return { path: 'host.yaml', etag: 'e2', outcome: 'applied' };
    }
    if (route === 'DELETE /v1/config/file') {
      text = undefined;
      return { path: 'host.yaml', etag: 'e3', outcome: 'removed' };
    }
    return new Error(`no route ${route}`);
  });
}

const typeInto = async (input: HTMLInputElement, value: string): Promise<void> => {
  await interact(async () => {
    const set = must(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set, 'the value setter');
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const press = async (container: HTMLElement): Promise<void> => {
  await interact(async () => {
    must(container.querySelector('form'), 'the form').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
  await settle();
};

const field = (container: HTMLElement) => must(container.querySelector<HTMLInputElement>('input'), 'the name field');

describe('Settings › General › Name', () => {
  it('shows the host name as the placeholder when no name was set', async () => {
    const { client } = namedDaemon();
    const view = await mount(createElement(NameSettings, { client }));
    await settle();
    expect(field(view.container).placeholder).toBe('pebox-hostname');
    expect(field(view.container).value).toBe('');
    expect(view.container.textContent).toContain('Using the host name (pebox-hostname)');
    await view.unmount();
  });

  it('saves a name as host.yaml against the etag it read, and then names the owner as its source', async () => {
    const { client, calls } = namedDaemon();
    const view = await mount(createElement(NameSettings, { client }));
    await settle();
    await typeInto(field(view.container), '  Büro 🦫  ');
    await press(view.container);
    const put = must(
      calls.find(call => call.route === 'PUT /v1/config/file'),
      'the write',
    );
    expect(put.init?.body).toEqual({ path: 'host.yaml', text: hostFileText('Büro 🦫'), etag: 'e0' });
    expect(view.container.textContent).toContain('Saved.');
    expect(view.container.textContent).toContain('Shown now: Büro 🦫');
    await view.unmount();
  });

  it('refuses a name with a control character before asking the daemon', async () => {
    const { client, calls } = namedDaemon();
    const view = await mount(createElement(NameSettings, { client }));
    await settle();
    await typeInto(field(view.container), 'bell\u0007');
    await press(view.container);
    expect(calls.some(call => call.route === 'PUT /v1/config/file')).toBe(false);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('control or invisible character');
    await view.unmount();
  });

  it('an empty field removes the owner’s name, which brings the host name back', async () => {
    const { client, calls } = namedDaemon(hostFileText('pebox'));
    const view = await mount(createElement(NameSettings, { client }));
    await settle();
    expect(field(view.container).value).toBe('pebox');
    await typeInto(field(view.container), '');
    await press(view.container);
    const removal = must(
      calls.find(call => call.route === 'DELETE /v1/config/file'),
      'the removal',
    );
    expect(removal.init?.query).toEqual({ path: 'host.yaml', etag: `e${String(hostFileText('pebox').length)}` });
    expect(view.container.textContent).toContain('Using the host name (pebox-hostname)');
    await view.unmount();
  });

  it('draws every state from plain values', async () => {
    const view = await mount(
      createElement(NameSettingsView, {
        current: 'pebox',
        source: 'owner',
        value: 'pebox',
        onChange: () => undefined,
        onSave: () => undefined,
        busy: false,
        problem: 'a machine name cannot be empty',
        saved: false,
      }),
    );
    expect(view.container.textContent).toContain('a machine name cannot be empty');
    expect(view.container.textContent).toContain('Shown now: pebox');
    await view.unmount();
  });
});

describe('A555 r7 kasen (a): a locked machine', () => {
  const locked = () =>
    Object.assign(new Error('this machine asks you to confirm it is you with a passkey before it shows anything'), {
      status: 401,
      code: 'unlock_required',
    });

  it('reads "Reading…" while the name is read, never "Saving…"', async () => {
    const view = await mount(
      createElement(NameSettings, { client: recordingClient(() => new Promise(() => undefined)).client }),
    );
    await settle();
    const button = must(view.container.querySelector<HTMLButtonElement>('button[type="submit"]'), 'Save');
    expect(button.textContent).toBe('Reading…');
    expect(button.disabled).toBe(true);
    await view.unmount();
  });

  it('offers "Unlock" for a refused read, and pressing it reads again (the person’s own read opens the prompt)', async () => {
    let unlocked = false;
    const daemon = namedDaemon();
    const { client, calls } = recordingClient((route, init) =>
      unlocked
        ? daemon.client.call(route, init)
        : route === 'GET /v1/config/file'
          ? locked()
          : daemon.client.call(route, init),
    );
    const view = await mount(createElement(NameSettings, { client }));
    await settle();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('confirm it is you with a passkey');
    const retry = must(view.container.querySelector<HTMLButtonElement>('[data-machine-name-retry]'), 'the press');
    expect(retry.textContent).toBe('Unlock');
    expect(view.container.querySelector('button[type="submit"]')?.textContent).toBe('Reading…');
    unlocked = true;
    await interact(() => retry.click());
    await settle();
    expect(calls.filter(call => call.route === 'GET /v1/config/file')).toHaveLength(2);
    expect(view.container.querySelector('[data-machine-name-retry]')).toBeNull();
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(view.container.querySelector('button[type="submit"]')?.textContent).toBe('Save');
    await view.unmount();
  });

  it('says a plain "Try again" for a failure that is not a passkey', async () => {
    const { client } = recordingClient(route =>
      route === 'GET /v1/config/file' ? new Error('gone') : { plugins: [] },
    );
    const view = await mount(createElement(NameSettings, { client }));
    await settle();
    expect(view.container.querySelector('[data-machine-name-retry]')?.textContent).toBe('Try again');
    await view.unmount();
  });
});
