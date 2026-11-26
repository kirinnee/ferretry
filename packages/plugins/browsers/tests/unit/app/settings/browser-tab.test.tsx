import { describe, expect, it } from 'bun:test';
import type { ViewPlace } from '@ferretry/app';
import { interact, mount, must, WithViewPlace } from '@ferretry/app/testing';
import browsersManifest from '../../../../manifest.ts';
import { BROWSER_USER_AGENT_WORDS, BrowserTab } from '../../../../app/features/settings/browser-tab.tsx';
import { STEALTH_HELD_NOTE, STEALTH_TERMS_NOTE } from '../../../../app/features/settings/browser-stealth-section.tsx';
import { STEALTH_LOOSENING } from '../../../../contract/config-loosens.ts';
import { PROXY_ERROR_WORDS } from '../../../../app/features/settings/browser-proxy-test-result.tsx';
import { BROWSER_OFFLINE_WORDS, browserStateSentence } from '../../../../app/features/settings/browser-state-line.tsx';
import type { RecordedCall } from '../../../support/app/client.ts';
import { recordingClient } from '../../../support/app/client.ts';

const CONFIG_GET = 'GET /v1/config/file';
const CONFIG_PUT = 'PUT /v1/config/file';
const CONFIG_STATUS = 'GET /v1/config/status';
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
  /** The kernel's way: after a held write the file on disk is the written text, read back with state `pending`. */
  readonly readsBackWhatWasWritten?: boolean;
  /** The file is already waiting for the owner when the tab opens (a held edit from before). */
  readonly heldAtLoad?: boolean;
  /** What the kernel says waits for the owner in browsers.yaml (its `pending[].changes`); the stealth `on` unless said otherwise. */
  readonly waiting?: readonly string[] | Error;
}

const tab = async (script: Script = {}, place?: ViewPlace) => {
  let text = script.text ?? 'mode: headless\n';
  let state: 'ok' | 'pending' = script.heldAtLoad === true ? 'pending' : 'ok';
  const recorded = recordingClient((route, init) => {
    if (route === CONFIG_GET) return { ...file(text), state };
    if (route === CONFIG_PUT) {
      if (script.readsBackWhatWasWritten === true) {
        text = ((init?.body ?? { text }) as { text: string }).text;
        state = 'pending';
      }
      return script.put ?? applied();
    }
    if (route === CONFIG_STATUS) {
      if (script.waiting instanceof Error) return script.waiting;
      return {
        directory: '/x',
        files: [],
        issues: [],
        pending: [{ path: 'browsers.yaml', etag: 'e', changes: script.waiting ?? [STEALTH_LOOSENING] }],
      };
    }
    if (route === STATE) return script.state ?? { state: 'stopped' };
    if (route === GRANTS) return script.grants ?? OPEN;
    if (route === 'GET /v1/secrets') return { secrets: [] };
    if (route === 'POST /v1/secrets') return {};
    if (route === 'DELETE /v1/secrets/:name') return {};
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
    // The Save bar is there from the first paint, clean: nothing to save, so Save is off.
    const bar = view.container.querySelector('[data-browser-mode-save-panel][data-setting-savebar]');
    expect(bar?.getAttribute('data-state')).toBe('clean');
    expect(
      (view.container.querySelector('[data-browser-mode-save-panel] [data-change-submit]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await click(view.container.querySelector('input[type="radio"]:not(:checked)'), 'the Real window choice');
    expect(bar?.getAttribute('data-state')).toBe('dirty');
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

  it('SF2 says a held proxy change is not in effect, and tests the saved proxy again only once a save took', async () => {
    const { calls, view } = await tab({
      put: { path: 'browsers.yaml', etag: 'etag-2', outcome: 'pending' },
      test: {
        reachable: true,
        tested: 'unsaved',
        roundTripMs: 42,
        egressIp: '203.0.113.7',
        message: 'The proxy answered.',
      },
    });
    await typeInto(view.container.querySelector('[data-browser-proxy-url]'), 'http://proxy.example.test:8080');
    await click(view.container.querySelector('[data-browser-proxy-save-panel] [data-change-submit]'), 'Save and test');
    expect(text(view.container, '[data-setup-note="browser-proxy-held"]')).toBe(
      'Saved, but not in effect until you confirm it.',
    );
    // The proxy was tried BEFORE it was written (the edit, as typed); a held write is not the saved proxy, so nothing tries it again.
    expect(calls.filter(call => call.route === PROXY_TEST)).toHaveLength(1);
    expect(body(calls, PROXY_TEST)).toEqual({
      proxy: expect.objectContaining({ url: 'http://proxy.example.test:8080' }),
    });
    await view.unmount();
  });

  it('a proxy that fails its test is not written, so the one that was saved stays in effect', async () => {
    const { calls, view } = await tab({
      test: { reachable: false, tested: 'unsaved', errorClass: 'connect', message: 'Nothing is listening.' },
    });
    await typeInto(view.container.querySelector('[data-browser-proxy-url]'), 'http://proxy.example.test:8080');
    await click(view.container.querySelector('[data-browser-proxy-save-panel] [data-change-submit]'), 'Save and test');
    expect(calls.some(call => call.route === CONFIG_PUT)).toBe(false);
    expect(text(view.container, '[data-setup-note="browser-proxy-save-refusal"]')).toContain('Not saved');
    expect(text(view.container, '[data-browser-proxy-test-class]')).toBe('Nothing is listening.');
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

  it('keeps a typed proxy username and password out of the markup, files each once, and empties the boxes', async () => {
    const USER = 'synthetic-proxy-user-0001';
    const PASS = 'synthetic-proxy-pass-0002';
    const { calls, view } = await tab({
      test: {
        reachable: true,
        tested: 'saved',
        roundTripMs: 42,
        egressIp: '203.0.113.7',
        message: 'The proxy answered.',
      },
    });
    const box = (what: 'username' | 'password') =>
      must(
        view.container.querySelector<HTMLInputElement>(`[data-browser-proxy-credential-value="${what}"]`),
        `the ${what} box`,
      );
    await typeInto(view.container.querySelector('[data-browser-proxy-url]'), 'http://proxy.example.test:8080');
    await typeInto(box('username'), USER);
    await typeInto(box('password'), PASS);
    // Typed: each box holds its value as the live value only, never as the `value` attribute or anywhere in the markup.
    expect(box('password').type).toBe('password');
    expect(box('username').getAttribute('value')).toBeNull();
    expect(box('password').getAttribute('value')).toBeNull();
    expect(view.container.innerHTML).not.toContain(USER);
    expect(view.container.innerHTML).not.toContain(PASS);
    const userBox = box('username');
    const passBox = box('password');
    await click(view.container.querySelector('[data-browser-proxy-save-panel] [data-change-submit]'), 'Save and test');
    const filed = calls
      .filter(call => call.route === 'POST /v1/secrets')
      .map(call => (call.init?.body as { name: string; value: string }) ?? { name: '', value: '' });
    expect(filed).toEqual([
      { name: 'PROXY_USER', value: USER },
      { name: 'PROXY_PASSWORD', value: PASS },
    ]);
    // Filed: nothing is left in either box, and the saved file holds only the names.
    expect(userBox.value).toBe('');
    expect(passBox.value).toBe('');
    const sent = body(calls, CONFIG_PUT) as { text: string };
    expect(sent.text).not.toContain(USER);
    expect(sent.text).not.toContain(PASS);
    expect(view.container.innerHTML).not.toContain(USER);
    expect(view.container.innerHTML).not.toContain(PASS);
    await view.unmount();
  });

  it('E-265 removes the credentials a failed Save and test just filed', async () => {
    const USER = 'synthetic-proxy-user-0003';
    const PASS = 'synthetic-proxy-pass-0004';
    const { calls, view } = await tab({
      test: { reachable: false, tested: 'unsaved', errorClass: 'auth', message: 'The proxy asked for a sign-in.' },
    });
    await typeInto(view.container.querySelector('[data-browser-proxy-url]'), 'http://proxy.example.test:8080');
    await typeInto(view.container.querySelector('[data-browser-proxy-credential-value="username"]'), USER);
    await typeInto(view.container.querySelector('[data-browser-proxy-credential-value="password"]'), PASS);
    await click(view.container.querySelector('[data-browser-proxy-save-panel] [data-change-submit]'), 'Save and test');
    const removed = calls
      .filter(call => call.route === 'DELETE /v1/secrets/:name')
      .map(call => call.init?.params?.name);
    expect(removed).toEqual(['PROXY_USER', 'PROXY_PASSWORD']);
    expect(calls.some(call => call.route === CONFIG_PUT)).toBe(false);
    await view.unmount();
  });

  it('E-265 removes the credentials a failed Test proxy just filed', async () => {
    const { calls, view } = await tab({
      test: { reachable: false, tested: 'unsaved', errorClass: 'auth', message: 'The proxy asked for a sign-in.' },
    });
    await typeInto(view.container.querySelector('[data-browser-proxy-url]'), 'socks5://proxy.example.test:1080');
    await typeInto(
      view.container.querySelector('[data-browser-proxy-credential-value="username"]'),
      'synthetic-proxy-user-0005',
    );
    await typeInto(
      view.container.querySelector('[data-browser-proxy-credential-value="password"]'),
      'synthetic-proxy-pass-0005',
    );
    await click(view.container.querySelector('[data-browser-proxy-test]'), 'Test proxy');
    expect(calls.filter(call => call.route === 'POST /v1/secrets')).toHaveLength(2);
    expect(
      calls.filter(call => call.route === 'DELETE /v1/secrets/:name').map(call => call.init?.params?.name),
    ).toEqual(['PROXY_USER', 'PROXY_PASSWORD']);
    await view.unmount();
  });

  it('E-265 keeps the filed credentials when the test works', async () => {
    const { calls, view } = await tab({
      test: {
        reachable: true,
        tested: 'unsaved',
        roundTripMs: 42,
        egressIp: '203.0.113.7',
        message: 'The proxy answered.',
      },
    });
    await typeInto(view.container.querySelector('[data-browser-proxy-url]'), 'socks5://proxy.example.test:1080');
    await typeInto(
      view.container.querySelector('[data-browser-proxy-credential-value="username"]'),
      'synthetic-proxy-user-0006',
    );
    await typeInto(
      view.container.querySelector('[data-browser-proxy-credential-value="password"]'),
      'synthetic-proxy-pass-0006',
    );
    await click(view.container.querySelector('[data-browser-proxy-test]'), 'Test proxy');
    expect(calls.filter(call => call.route === 'POST /v1/secrets')).toHaveLength(2);
    expect(calls.some(call => call.route === 'DELETE /v1/secrets/:name')).toBe(false);
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
      'The operator of this machine switched off the agent fleet for paired devices, this browser included. It is turned back on at the machine with fy.',
      'The operator of this machine switched off the agent fleet for paired devices, this browser included. It is turned back on at the machine with fy.',
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

describe('the Stealth switch on the Browser tab', () => {
  const stealthSwitch = (container: HTMLElement): HTMLButtonElement =>
    must(
      container.querySelector('[data-setup-section="browser-stealth"] [role="switch"]') as HTMLButtonElement,
      'the stealth switch',
    );

  it('is off by default, with the terms note beside it', async () => {
    const { view } = await tab();
    expect(stealthSwitch(view.container).getAttribute('aria-checked')).toBe('false');
    expect(text(view.container, '[data-browser-stealth-note]')).toBe(STEALTH_TERMS_NOTE);
    await view.unmount();
  });

  it('writes stealth: on against the digest it was read at, keeping the file’s comments', async () => {
    const { calls, view } = await tab({ text: '# the shared browser\nmode: headless\n' });
    await click(stealthSwitch(view.container), 'the stealth switch');
    const sent = body(calls, CONFIG_PUT) as { text: string; etag: string };
    expect(sent.etag).toBe('etag-1');
    expect(sent.text).toContain('# the shared browser');
    expect(sent.text).toContain('stealth: on');
    await view.unmount();
  });

  it('keeps a held on as a lasting waiting note with the switch off, after the file is read back as the kernel serves it', async () => {
    const { calls, view } = await tab({
      put: { path: 'browsers.yaml', etag: 'etag-2', outcome: 'pending' },
      readsBackWhatWasWritten: true,
    });
    await click(stealthSwitch(view.container), 'the stealth switch');
    // The re-read after the write returned the disk text (`stealth: on`) with state `pending`.
    expect(calls.filter(call => call.route === CONFIG_GET).length).toBeGreaterThan(1);
    expect(text(view.container, '[data-setup-note="browser-stealth-held"]')).toBe(STEALTH_HELD_NOTE);
    expect(stealthSwitch(view.container).getAttribute('aria-checked')).toBe('false');
    await view.unmount();
  });

  it('shows the held note and the switch off on a fresh load of a file holding an unconfirmed on, from the daemon alone', async () => {
    const { view } = await tab({ text: 'mode: headless\nstealth: on\n', heldAtLoad: true });
    expect(stealthSwitch(view.container).getAttribute('aria-checked')).toBe('false');
    expect(text(view.container, '[data-setup-note="browser-stealth-held"]')).toBe(STEALTH_HELD_NOTE);
    await view.unmount();
  });

  it('reads ON, with no waiting note, when the file is held for another key while stealth is already on in effect', async () => {
    // The file says stealth: on and is pending — but what waits is the proxy, so the switch is on in effect.
    const { view } = await tab({
      text: 'mode: headless\nstealth: on\nproxy:\n  url: http://127.0.0.1:8080\n',
      heldAtLoad: true,
      waiting: ['the agent browser now sends its traffic through the proxy at http://127.0.0.1:8080'],
    });
    expect(stealthSwitch(view.container).getAttribute('aria-checked')).toBe('true');
    expect(view.container.querySelector('[data-setup-note="browser-stealth-held"]')).toBeNull();
    await view.unmount();
  });

  it('reads OFF with the waiting note when the stealth on waits beside another held key', async () => {
    const { view } = await tab({
      text: 'mode: headless\nstealth: on\n',
      heldAtLoad: true,
      waiting: [
        'the agent browser now sends its traffic through the proxy at http://127.0.0.1:8080',
        STEALTH_LOOSENING,
      ],
    });
    expect(stealthSwitch(view.container).getAttribute('aria-checked')).toBe('false');
    expect(text(view.container, '[data-setup-note="browser-stealth-held"]')).toBe(STEALTH_HELD_NOTE);
    await view.unmount();
  });

  it('reads OFF, the safe side, when the daemon cannot say what waits', async () => {
    const { view } = await tab({
      text: 'mode: headless\nstealth: on\n',
      heldAtLoad: true,
      waiting: new Error('no status'),
    });
    expect(stealthSwitch(view.container).getAttribute('aria-checked')).toBe('false');
    expect(text(view.container, '[data-setup-note="browser-stealth-held"]')).toBe(STEALTH_HELD_NOTE);
    await view.unmount();
  });

  it('turns it off with one write, nothing held', async () => {
    const { calls, view } = await tab({ text: 'mode: headless\nstealth: on\n' });
    expect(stealthSwitch(view.container).getAttribute('aria-checked')).toBe('true');
    await click(stealthSwitch(view.container), 'the stealth switch');
    expect((body(calls, CONFIG_PUT) as { text: string }).text).toContain('stealth: off');
    expect(view.container.querySelector('[data-setup-note="browser-stealth-held"]')).toBeNull();
    await view.unmount();
  });

  it('puts a refusal in front of the person', async () => {
    const { view } = await tab({ put: new Error('browsers.yaml changed since you read it') });
    await click(stealthSwitch(view.container), 'the stealth switch');
    expect(text(view.container, '[data-setup-note="browser-stealth-refusal"]')).toContain('changed since you read it');
    await view.unmount();
  });
});
