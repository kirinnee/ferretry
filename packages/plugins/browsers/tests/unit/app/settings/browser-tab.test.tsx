import { describe, expect, it } from 'bun:test';
import type { ViewPlace } from '@ferretry/app';
import { interact, mount, must, WithViewPlace } from '@ferretry/app/testing';
import browsersManifest from '../../../../manifest.ts';
import { BROWSER_USER_AGENT_WORDS, BrowserTab } from '../../../../app/features/settings/browser-tab.tsx';
import { PROXY_ERROR_WORDS } from '../../../../app/features/settings/browser-proxy-test-result.tsx';
import { BROWSER_OFFLINE_WORDS, browserStateSentence } from '../../../../app/features/settings/browser-state-line.tsx';
import type { RecordedCall } from '../../../support/app/client.ts';
import { recordingClient } from '../../../support/app/client.ts';

const CONFIG_GET = 'GET /v1/config/file';
const CONFIG_PUT = 'PUT /v1/config/file';
const STATE = 'GET /v1/browser/state';
const PROXY_TEST = 'POST /v1/browser/proxy/test';
const GRANTS = 'GET /v1/grants';

/** What Gate answers about the `fleet` capability for this caller: the one row the panel decides on. */
const grants = (configure: boolean, configureRefusal: string) => ({
  capabilities: [{ capability: 'fleet', configure, configureRefusal }],
});
const OPEN = grants(true, 'granted');

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  });
};

const click = async (element: Element | null, what: string): Promise<void> => {
  const target = must(element as HTMLElement | null, what);
  await interact(() => target.click());
  await settle();
};

const typeInto = async (element: Element | null, value: string): Promise<void> => {
  const field = must(element as HTMLInputElement | HTMLTextAreaElement | null, 'the field');
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await interact(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
};

const file = (text: string, etag = 'etag-1') => ({ path: 'browsers.yaml', exists: true, text, etag });
const applied = (etag = 'etag-2') => ({ path: 'browsers.yaml', etag, outcome: 'applied' });

interface Script {
  readonly text?: string;
  readonly state?: unknown;
  readonly put?: unknown;
  readonly test?: unknown;
  readonly grants?: unknown;
}

const tab = async (script: Script = {}, place?: ViewPlace) => {
  const text = script.text ?? 'mode: headless\n';
  const recorded = recordingClient(route => {
    if (route === CONFIG_GET) return file(text);
    if (route === CONFIG_PUT) return script.put ?? applied();
    if (route === STATE) return script.state ?? { state: 'stopped' };
    if (route === GRANTS) return script.grants ?? OPEN;
    if (route === 'GET /v1/secrets') return { secrets: [] };
    if (route === PROXY_TEST) return script.test ?? new Error('no test scripted');
    return new Error(`no route ${route}`);
  });
  const drawn = <BrowserTab client={recorded.client} />;
  const view = await mount(place === undefined ? drawn : <WithViewPlace place={place}>{drawn}</WithViewPlace>);
  await settle();
  return { ...recorded, view };
};

const body = (calls: readonly RecordedCall[], route: string): unknown =>
  calls.filter(call => call.route === route).at(-1)?.init?.body;

const text = (container: HTMLElement, selector: string): string => container.querySelector(selector)?.textContent ?? '';

describe('the Browser tab', () => {
  it('D2 #3 reads and writes browsers.yaml over the kernel’s config routes, declaring the file and none of the routes', () => {
    // Browsers declares the FILE the kernel resolves the path to, and none of the kernel's routes itself.
    expect((browsersManifest.actions?.routes ?? []).map(route => route.key)).not.toContain(CONFIG_GET);
    expect((browsersManifest.actions?.routes ?? []).map(route => route.key)).not.toContain(CONFIG_PUT);
    expect((browsersManifest.data?.config ?? []).map(def => ('file' in def ? def.file : undefined))).toContain(
      'browsers.yaml',
    );
  });

  it('reads browsers.yaml and the browser state through its own client, by route key', async () => {
    const { calls, view } = await tab({ state: { state: 'running' } });
    expect(calls.map(call => call.route).sort()).toEqual([CONFIG_GET, STATE, GRANTS, 'GET /v1/secrets'].sort());
    expect(calls.find(call => call.route === CONFIG_GET)?.init?.query).toEqual({ path: 'browsers.yaml' });
    expect(text(view.container, '[data-browser-state]')).toBe('Running · direct, no proxy.');
    expect(text(view.container, '[data-browser-user-agent]')).toBe(BROWSER_USER_AGENT_WORDS);
    await view.unmount();
  });

  it('says why the settings did not load, and still shows the status and the user agent', async () => {
    const recorded = recordingClient(route => {
      if (route === CONFIG_GET) return new Error('this machine does not serve configuration');
      if (route === STATE)
        return {
          state: 'running',
          proxy: { url: 'http://proxy.example.test:8080', authenticated: true, bypassCount: 1 },
        };
      return new Error('unexpected');
    });
    const view = await mount(<BrowserTab client={recorded.client} />);
    await settle();
    expect(text(view.container, '[data-browser-settings-reason]')).toContain('does not serve configuration');
    expect(text(view.container, '[data-browser-state]')).toBe(
      'Running · via proxy http://proxy.example.test:8080 · signs in.',
    );
    expect(view.container.querySelector('[data-browser-mode-save-panel] [data-change-submit]')).toBeNull();
    expect(text(view.container, '[data-browser-user-agent]')).toBe(BROWSER_USER_AGENT_WORDS);
    await view.unmount();
  });

  it('says the status is unknown when the machine does not report it', async () => {
    const recorded = recordingClient(route => (route === CONFIG_GET ? file('') : new Error('down')));
    const view = await mount(<BrowserTab client={recorded.client} />);
    await settle();
    expect(text(view.container, '[data-browser-state]')).toBe(
      'This machine did not say whether its browser is running.',
    );
    await view.unmount();
  });

  it('saves a changed mode against the digest it was read at, keeping the file’s comments', async () => {
    const { calls, view } = await tab({ text: '# the shared browser\nmode: headless\n' });
    expect(view.container.querySelector('[data-browser-mode-save-panel] [data-change-submit]')).toBeNull();
    await click(view.container.querySelector('input[type="radio"]:not(:checked)'), 'the Real window choice');
    await click(
      view.container.querySelector('[data-browser-mode-save-panel] [data-change-submit]'),
      'Save browser mode',
    );
    const sent = body(calls, CONFIG_PUT) as { path: string; text: string; etag: string };
    expect(sent.path).toBe('browsers.yaml');
    expect(sent.etag).toBe('etag-1');
    expect(sent.text).toContain('# the shared browser');
    expect(sent.text).toContain('mode: window');
    // The write took, so the document was read again for the next write's digest.
    expect(calls.filter(call => call.route === CONFIG_GET)).toHaveLength(2);
    await view.unmount();
  });

  it('puts the daemon’s refusal of a save in front of the person instead of pretending it took', async () => {
    const { view } = await tab({ put: new Error('browsers.yaml changed since you read it') });
    await click(view.container.querySelector('input[type="radio"]:not(:checked)'), 'the Real window choice');
    await click(
      view.container.querySelector('[data-browser-mode-save-panel] [data-change-submit]'),
      'Save browser mode',
    );
    expect(view.container.textContent).toContain('browsers.yaml changed since you read it');
    expect(view.container.querySelector('[data-browser-mode-save-panel] [data-change-submit]')).not.toBeNull();
    await view.unmount();
  });

  it('SF2 says a held mode change is saved but not in effect until the owner confirms it', async () => {
    const { view } = await tab({ put: { path: 'browsers.yaml', etag: 'etag-2', outcome: 'pending' } });
    await click(view.container.querySelector('input[type="radio"]:not(:checked)'), 'the Real window choice');
    await click(
      view.container.querySelector('[data-browser-mode-save-panel] [data-change-submit]'),
      'Save browser mode',
    );
    expect(text(view.container, '[data-setup-note="browser-mode-held"]')).toBe(
      'Saved, but not in effect until you confirm it.',
    );
    expect(view.container.querySelector('[data-setup-note="browser-mode-refusal"]')).toBeNull();
    await view.unmount();
  });

  it('SF2 says a held proxy change is not in effect, and does not test a proxy that is not saved yet', async () => {
    const { calls, view } = await tab({ put: { path: 'browsers.yaml', etag: 'etag-2', outcome: 'pending' } });
    await typeInto(view.container.querySelector('[data-browser-proxy-url]'), 'http://proxy.example.test:8080');
    await click(view.container.querySelector('[data-browser-proxy-save-panel] [data-change-submit]'), 'Save and test');
    expect(text(view.container, '[data-setup-note="browser-proxy-held"]')).toBe(
      'Saved, but not in effect until you confirm it.',
    );
    expect(calls.some(call => call.route === PROXY_TEST)).toBe(false);
    await view.unmount();
  });

  it('saves a proxy as the file’s setting and then tests the saved one, never carrying a credential value', async () => {
    const { calls, view } = await tab({
      test: {
        reachable: true,
        tested: 'saved',
        roundTripMs: 42,
        egressIp: '203.0.113.7',
        message: 'The proxy answered.',
      },
    });
    await typeInto(view.container.querySelector('[data-browser-proxy-url]'), 'http://proxy.example.test:8080');
    await click(view.container.querySelector('[data-browser-proxy-save-panel] [data-change-submit]'), 'Save and test');
    const sent = body(calls, CONFIG_PUT) as { text: string };
    expect(sent.text).toContain('url: http://proxy.example.test:8080');
    expect(body(calls, PROXY_TEST)).toEqual({});
    expect(text(view.container, '[data-browser-proxy-test-egress]')).toContain('203.0.113.7');
    expect(text(view.container, '[data-browser-proxy-test-tested]')).toBe('Tested the saved proxy.');
    await view.unmount();
  });

  it('tests the proxy being edited without saving it', async () => {
    const { calls, view } = await tab({
      test: {
        reachable: false,
        tested: 'unsaved',
        errorClass: 'auth',
        message: 'The proxy asked for a sign-in.',
      },
    });
    await typeInto(view.container.querySelector('[data-browser-proxy-url]'), 'socks5://proxy.example.test:1080');
    await click(view.container.querySelector('[data-browser-proxy-test]'), 'Test proxy');
    expect(body(calls, PROXY_TEST)).toEqual({ proxy: { url: 'socks5://proxy.example.test:1080', bypass: [] } });
    expect(calls.some(call => call.route === CONFIG_PUT)).toBe(false);
    expect(view.container.textContent).toContain(PROXY_ERROR_WORDS.auth);
    expect(text(view.container, '[data-browser-proxy-test-tested]')).toContain('It is not saved');
    await view.unmount();
  });

  it('tells a device that needs its passkey so, before the save, and still lets it save', async () => {
    const { view } = await tab({ grants: grants(false, 'step-up-required') });
    await click(view.container.querySelector('input[type="radio"]:not(:checked)'), 'the Real window choice');
    expect(text(view.container, '[data-change-step-up]')).toBe(
      'This machine will ask you to confirm with your passkey when you save.',
    );
    const save = view.container.querySelector(
      '[data-browser-mode-save-panel] [data-change-submit]',
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await typeInto(view.container.querySelector('[data-browser-proxy-url]'), 'http://proxy.example.test:8080');
    expect(view.container.querySelectorAll('[data-change-step-up]')).toHaveLength(2);
    expect(view.container.querySelector('[data-change-grant-refused]')).toBeNull();
    await view.unmount();
  });

  it('explains a refused grant and disables Save, for the mode and for the proxy', async () => {
    const { calls, view } = await tab({ grants: grants(false, 'not-granted') });
    await click(view.container.querySelector('input[type="radio"]:not(:checked)'), 'the Real window choice');
    await typeInto(view.container.querySelector('[data-browser-proxy-url]'), 'http://proxy.example.test:8080');
    const explanations = [...view.container.querySelectorAll('[data-change-grant-refused]')].map(
      node => node.textContent,
    );
    expect(explanations).toEqual([
      'The operator of this machine switched off the agent fleet for paired devices, this browser included. It is turned back on at the machine with \`fy\`.',
      'The operator of this machine switched off the agent fleet for paired devices, this browser included. It is turned back on at the machine with \`fy\`.',
    ]);
    for (const selector of [
      '[data-browser-mode-save-panel] [data-change-submit]',
      '[data-browser-proxy-save-panel] [data-change-submit]',
    ]) {
      const save = must(view.container.querySelector(selector) as HTMLButtonElement | null, selector);
      expect(save.disabled).toBe(true);
      await click(save, selector);
    }
    expect(calls.some(call => call.route === CONFIG_PUT)).toBe(false);
    expect(view.container.querySelector('[data-change-step-up]')).toBeNull();
    await view.unmount();
  });

  it('says nothing extra for the owner on the host, whose Save is open', async () => {
    const { view } = await tab();
    await click(view.container.querySelector('input[type="radio"]:not(:checked)'), 'the Real window choice');
    await typeInto(view.container.querySelector('[data-browser-proxy-url]'), 'http://proxy.example.test:8080');
    expect(view.container.querySelector('[data-change-step-up]')).toBeNull();
    expect(view.container.querySelector('[data-change-grant-refused]')).toBeNull();
    for (const selector of [
      '[data-browser-mode-save-panel] [data-change-submit]',
      '[data-browser-proxy-save-panel] [data-change-submit]',
    ]) {
      expect(must(view.container.querySelector(selector) as HTMLButtonElement | null, selector).disabled).toBe(false);
    }
    await view.unmount();
  });

  it('says in one sentence how a stopped browser will next start', () => {
    expect(browserStateSentence({ state: 'stopped' }, true)).toContain('via the saved proxy');
    expect(browserStateSentence({ state: 'stopped' }, false)).toContain('direct');
    expect(browserStateSentence({ state: 'starting' }, false)).toBe('Starting…');
  });

  it('names its machine, and while it is offline says so and reads no status (shell contract S1)', async () => {
    const place = (online: boolean): ViewPlace => ({
      daemon: 'd1',
      machine: 'studio-mac',
      online,
      authority: () => ({ kind: 'open' }),
      authorityOf: () => ({ kind: 'open' }),
      press: act => act(),
    });
    const offline = await tab({}, place(false));
    const container = offline.view.container;
    expect(text(container, '[data-browser-state]')).toBe(BROWSER_OFFLINE_WORDS);
    expect(offline.calls.map(call => call.route)).not.toContain(STATE);
    expect((container.querySelector('[data-browser-state-refresh]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('the browser on studio-mac starts');
    expect(container.textContent).not.toContain('on this machine');
    await offline.view.unmount();
    const online = await tab({}, place(true));
    expect(online.calls.map(call => call.route)).toContain(STATE);
    expect(text(online.view.container, '[data-browser-state]')).toContain('Stopped');
    await online.view.unmount();
  });
});
