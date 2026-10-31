import { describe, expect, it } from 'bun:test';
import {
  BROWSER_PROXY_ERROR_CLASSES,
  BROWSER_PROXY_TEST_PATH,
  BROWSER_STATE_PATH,
  type BrowserProxyErrorClass,
  type BrowserProxyTestResult,
  type BrowserStateView,
  type FleetMachineView,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { z } from 'zod';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { browserStateSentence } from '../../../../../src/features/fleet/machine/browser-state-line.tsx';
import { BROWSER_USER_AGENT_WORDS, BrowserTab } from '../../../../../src/features/fleet/machine/browser-tab.tsx';
import { PROXY_ERROR_WORDS } from '../../../../../src/features/fleet/machine/browser-proxy-test-result.tsx';
import { interact, mount, must } from '../../../../support/dom.ts';
import { APPLY_PATH, machineAnswer, machineView, STAGED, STUDIO } from '../setup/setup-support.ts';

const OUTCOME = { outcome: 'executed', executor: 'setup', summary: 'Saved' };

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
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

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Answer = unknown | Error | ((call: Recorded) => unknown | Promise<unknown>);

/** A scripted daemon that also records the method, and may answer later (a promise) for the busy state. */
const fakeClient = (answers: Readonly<Record<string, Answer>>, calls: Recorded[]): FleetClient => ({
  request: async <T,>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
    const call: Recorded = {
      path,
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (!(path in answers)) throw new Error(`no route ${path}`);
    const answer = answers[path];
    const value = typeof answer === 'function' ? await (answer as (call: Recorded) => unknown)(call) : answer;
    if (value instanceof Error) throw value;
    return schema.parse(value);
  },
});

const ref = (name: string): string => `\${secret:${name}}`;

const PROXY = {
  url: 'http://proxy.example.test:8080',
  bypass: ['*.internal.example.test'],
  username: ref('PROXY_USER'),
  password: ref('PROXY_PASSWORD'),
};

const reachable = (overrides: Partial<BrowserProxyTestResult> = {}): BrowserProxyTestResult =>
  ({
    reachable: true,
    tested: 'saved',
    roundTripMs: 182,
    egressIp: '203.0.113.7',
    message: 'The proxy answered and the test endpoint saw its address.',
    ...overrides,
  }) as BrowserProxyTestResult;

const unreachable = (errorClass: BrowserProxyErrorClass, message: string): BrowserProxyTestResult => ({
  reachable: false,
  tested: 'saved',
  errorClass,
  message,
});

const RUNNING: BrowserStateView = {
  state: 'running',
  startedAt: '2026-10-30T08:00:00.000Z',
  proxy: { url: 'http://proxy.example.test:8080', authenticated: true, bypassCount: 1 },
};

interface Setup {
  readonly machine?: FleetMachineView | null;
  readonly online?: boolean;
  readonly checking?: boolean;
  readonly answers?: Readonly<Record<string, Answer>>;
}

const withTab = async (
  setup: Setup,
  run: (ctx: {
    readonly container: HTMLElement;
    readonly calls: Recorded[];
    readonly refreshed: { count: number };
    readonly q: (selector: string) => Element | null;
  }) => Promise<void>,
): Promise<void> => {
  const calls: Recorded[] = [];
  const refreshed = { count: 0 };
  const client = fakeClient(
    { '/v1/fleet/machine': machineAnswer(), [BROWSER_STATE_PATH]: { state: 'stopped' }, ...setup.answers },
    calls,
  );
  const view = await mount(
    <BrowserTab
      connection={STUDIO}
      machineName="studio-mac"
      machine={setup.machine === undefined ? machineView() : setup.machine}
      online={setup.online ?? true}
      checking={setup.checking ?? false}
      onRetry={() => {
        refreshed.count += 1;
      }}
      createClient={async () => client}
    />,
  );
  try {
    await settle();
    await run({ container: view.container, calls, refreshed, q: selector => view.container.querySelector(selector) });
  } finally {
    await view.unmount();
  }
};

const withProxy = (overrides: Partial<FleetMachineView> = {}): FleetMachineView =>
  machineView({ browserMode: 'headless', browserProxy: PROXY, ...overrides });

describe('BrowserTab › the page', () => {
  it('waits for a machine that has not answered, saying whether it is checking', async () => {
    await withTab({ machine: null, checking: true }, async ({ q }) => {
      expect(q('[data-browser-tab-waiting]')?.textContent).toBe('Checking studio-mac…');
    });
    await withTab({ machine: null }, async ({ q }) => {
      expect(q('[data-browser-tab-waiting]')?.textContent).toContain('show once it answers');
    });
  });

  it('puts status, mode, proxy and the user agent on one tab, in that order', async () => {
    await withTab({ machine: withProxy() }, async ({ container }) => {
      const sections = Array.from(container.querySelectorAll('[data-setup-section]')).map(node =>
        node.getAttribute('data-setup-section'),
      );
      expect(sections).toEqual(['browser-status', 'browser-mode', 'browser-proxy', 'browser-user-agent']);
    });
  });

  it('says only what is true about the user agent', async () => {
    await withTab({ machine: withProxy() }, async ({ q }) => {
      const words = q('[data-browser-user-agent]')?.textContent ?? '';
      expect(words).toBe(BROWSER_USER_AGENT_WORDS);
      expect(words).toContain('HeadlessChrome');
      expect(words).toContain('ordinary Chrome user agent');
      expect(words).toContain('Nothing else about it is changed.');
    });
  });
});

describe('BrowserTab › status line', () => {
  it('words each state', () => {
    expect(browserStateSentence(RUNNING, true)).toBe('Running · via proxy http://proxy.example.test:8080 · signs in.');
    expect(
      browserStateSentence(
        { state: 'running', proxy: { url: 'socks5://p.example.test:1080', authenticated: false, bypassCount: 0 } },
        true,
      ),
    ).toBe('Running · via proxy socks5://p.example.test:1080 · no sign-in.');
    expect(browserStateSentence({ state: 'running' }, false)).toBe('Running · direct, no proxy.');
    expect(browserStateSentence({ state: 'stopped' }, true)).toBe('Stopped · the next start goes via the saved proxy.');
    expect(browserStateSentence({ state: 'stopped' }, false)).toBe('Stopped · the next start goes direct.');
    expect(browserStateSentence({ state: 'starting' }, false)).toBe('Starting…');
    expect(browserStateSentence({ state: 'stopping' }, false)).toBe('Stopping…');
    expect(browserStateSentence({ state: 'error' }, false)).toContain('Stopped after an error.');
  });

  it('reads the machine’s browser state and shows it', async () => {
    await withTab({ machine: withProxy(), answers: { [BROWSER_STATE_PATH]: RUNNING } }, async ({ q, calls }) => {
      expect(q('[data-browser-state]')?.textContent).toBe(
        'Running · via proxy http://proxy.example.test:8080 · signs in.',
      );
      expect(q('[data-browser-state]')?.getAttribute('data-browser-state')).toBe('running');
      expect(calls.filter(call => call.path === BROWSER_STATE_PATH)).toHaveLength(1);
      expect(calls.find(call => call.path === BROWSER_STATE_PATH)?.method).toBe('GET');
    });
  });

  it('reads it again on Refresh', async () => {
    let state: BrowserStateView = { state: 'stopped' };
    await withTab({ machine: withProxy(), answers: { [BROWSER_STATE_PATH]: () => state } }, async ({ q, calls }) => {
      expect(q('[data-browser-state]')?.textContent).toBe('Stopped · the next start goes via the saved proxy.');
      state = { state: 'running' };
      await click(q('[data-browser-state-refresh]'), 'refresh');
      expect(q('[data-browser-state]')?.textContent).toBe('Running · direct, no proxy.');
      expect(calls.filter(call => call.path === BROWSER_STATE_PATH)).toHaveLength(2);
    });
  });

  it('says so when the machine cannot tell, and asks nothing while it is offline', async () => {
    await withTab({ answers: { [BROWSER_STATE_PATH]: new Error('older daemon') } }, async ({ q }) => {
      expect(q('[data-browser-state]')?.textContent).toBe('This machine did not say whether its browser is running.');
    });
    await withTab({ online: false }, async ({ q, calls }) => {
      expect(q('[data-browser-state]')?.textContent).toContain('Offline');
      expect(calls.some(call => call.path === BROWSER_STATE_PATH)).toBe(false);
      expect(q('[data-browser-state-refresh]')).toHaveProperty('disabled', true);
    });
  });
});

describe('BrowserTab › Browser mode', () => {
  it('hides it for a daemon that predates it', async () => {
    await withTab({}, async ({ q }) => {
      expect(q('[data-setup-section="browser-mode"]')).toBeNull();
    });
  });

  it('offers Headless and Real window, and Save sends the chosen mode', async () => {
    await withTab(
      {
        machine: machineView({ browserMode: 'headless' }),
        answers: { '/v1/fleet/proposals': STAGED, [APPLY_PATH]: OUTCOME },
      },
      async ({ q, calls, refreshed }) => {
        const section = must(q('[data-setup-section="browser-mode"]'), 'browser mode');
        expect(section.querySelector('[data-setup-choice="headless"]')?.textContent).toContain('Headless');
        expect(section.querySelector('[data-setup-choice="window"]')?.textContent).toContain('needs Xvfb');
        expect(q('[data-browser-mode-hint]')?.textContent).toContain(
          'Applies the next time the browser on studio-mac starts.',
        );
        expect(q('[data-change-submit]')).toBeNull();
        await click(q('[data-setup-choice="window"] input'), 'window radio');
        expect(q('[data-change-submit]')?.textContent).toBe('Save browser mode');
        expect(q('[data-browser-mode-undo]')?.textContent).toBe('Keep Headless');
        await click(q('[data-change-submit]'), 'save');
        const staged = must(
          calls.find(call => call.path === '/v1/fleet/proposals'),
          'the staged change',
        );
        expect(JSON.stringify(staged.body)).toContain('"browserMode":"window"');
        expect(refreshed.count).toBe(1);
      },
    );
  });
});

describe('BrowserTab › Browser proxy', () => {
  it('hides it for a daemon that predates it', async () => {
    await withTab({}, async ({ q }) => {
      expect(q('[data-setup-section="browser-proxy"]')).toBeNull();
      expect(q('[data-browser-proxy-test]')).toBeNull();
    });
  });

  it('saves a proxy that names its secrets, and Keep puts the saved form back', async () => {
    await withTab(
      {
        machine: machineView({ browserProxy: null }),
        answers: { '/v1/fleet/proposals': STAGED, [APPLY_PATH]: OUTCOME },
      },
      async ({ q, calls, refreshed }) => {
        expect(q('[data-browser-proxy-hint]')?.textContent).toContain(
          'Applies the next time the browser on studio-mac',
        );
        const fill = async (): Promise<void> => {
          await typeInto(q('[data-browser-proxy-url]'), 'http://proxy.example:8080');
          await typeInto(q('[data-browser-proxy-bypass]'), '*.internal.example, 10.0.0.0/8');
          await typeInto(q('[data-browser-proxy-username]'), 'PROXY_USER');
          await typeInto(q('[data-browser-proxy-password]'), 'PROXY_PASSWORD');
        };
        await fill();
        expect(q('[data-change-submit]')?.textContent).toBe('Save browser proxy');
        await click(q('[data-browser-proxy-undo]'), 'keep');
        expect(q('[data-change-submit]')).toBeNull();
        expect((q('[data-browser-proxy-url]') as HTMLInputElement).value).toBe('');
        await fill();
        await click(q('[data-change-submit]'), 'save');
        const staged = must(
          calls.find(call => call.path === '/v1/fleet/proposals'),
          'the staged change',
        );
        const body = JSON.stringify(staged.body);
        expect(body).toContain('"url":"http://proxy.example:8080"');
        expect(body).toContain('"bypass":["*.internal.example","10.0.0.0/8"]');
        expect(body).toContain(ref('PROXY_USER'));
        expect(refreshed.count).toBe(1);
      },
    );
  });

  it('turns a saved proxy off by emptying the address, sending null', async () => {
    await withTab(
      {
        machine: machineView({ browserProxy: { url: 'socks5://proxy.example:1080', bypass: [] } }),
        answers: { '/v1/fleet/proposals': STAGED, [APPLY_PATH]: OUTCOME },
      },
      async ({ q, calls }) => {
        await typeInto(q('[data-browser-proxy-url]'), '');
        expect(q('[data-change-submit]')?.textContent).toBe('Turn the browser proxy off');
        await click(q('[data-change-submit]'), 'save');
        const staged = must(
          calls.find(call => call.path === '/v1/fleet/proposals'),
          'the staged change',
        );
        expect(JSON.stringify(staged.body)).toContain('"browserProxy":null');
      },
    );
  });

  it('says what to fix and offers no save while the proxy is not valid', async () => {
    await withTab({ machine: machineView({ browserProxy: null }) }, async ({ q }) => {
      await typeInto(q('[data-browser-proxy-url]'), 'ftp://proxy.example');
      expect(q('[data-setup-note="browser-proxy-problem"]')).not.toBeNull();
      expect(q('[data-change-submit]')).toBeNull();
      await typeInto(q('[data-browser-proxy-url]'), 'http://proxy.example:8080');
      expect(q('[data-setup-note="browser-proxy-problem"]')).toBeNull();
      expect(q('[data-change-submit]')).not.toBeNull();
    });
  });
});

const afterwards = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });
};

describe('BrowserTab › Test proxy', () => {
  const testCalls = (calls: readonly Recorded[]): Recorded[] =>
    calls.filter(call => call.path === BROWSER_PROXY_TEST_PATH);
  const button = (q: (selector: string) => Element | null): HTMLButtonElement =>
    must(q('[data-browser-proxy-test]') as HTMLButtonElement | null, 'the Test proxy button');

  it('is disabled with nothing saved and nothing typed, and says to type an address', async () => {
    await withTab({ machine: machineView({ browserProxy: null }) }, async ({ q }) => {
      expect(button(q).disabled).toBe(true);
      expect(q('[data-browser-proxy-test-hint]')?.textContent).toBe('Type a proxy address to test it.');
    });
  });

  it('stays pressable while the typed proxy is not valid, and says what to fix instead of asking the machine', async () => {
    await withTab({ machine: machineView({ browserProxy: null }) }, async ({ q, calls }) => {
      await typeInto(q('[data-browser-proxy-url]'), 'ftp://proxy.example');
      expect(button(q).disabled).toBe(false);
      await click(button(q), 'test');
      expect(q('[data-setup-note="browser-proxy-problem"]')?.textContent).toContain('starts with http://');
      expect(q('[data-browser-proxy-test-refusal]')?.textContent).toContain('Fix the problem in the note just above');
      expect(testCalls(calls)).toHaveLength(0);
      await typeInto(q('[data-browser-proxy-url]'), 'http://proxy.example:8080');
      expect(q('[data-browser-proxy-test-refusal]')).toBeNull();
    });
  });

  it('explains that the boxes take secret NAMES when a real user name or password was typed there', async () => {
    await withTab({ machine: machineView({ browserProxy: null }) }, async ({ q, calls }) => {
      await typeInto(q('[data-browser-proxy-url]'), 'socks5://proxy.example:1080');
      await typeInto(q('[data-browser-proxy-username]'), 'amy');
      await typeInto(q('[data-browser-proxy-password]'), 'hunter2!');
      expect(button(q).disabled).toBe(false);
      await click(button(q), 'test');
      expect(q('[data-browser-proxy-test-refusal]')?.textContent).toContain('Fix the problem in the note just above');
      const sentence = q('[data-setup-note="browser-proxy-problem"]')?.textContent ?? '';
      expect(sentence).toContain('takes the NAME of a stored secret');
      expect(sentence).toContain('Paste the real');
      expect(testCalls(calls)).toHaveLength(0);
    });
  });

  it('stores a pasted password under a default name, empties the box, and fills the name box', async () => {
    await withTab(
      {
        machine: machineView({ browserProxy: null }),
        answers: {
          '/v1/secrets': {
            name: 'PROXY_PASSWORD',
            createdAt: '2026-10-31T01:00:00.000Z',
            updatedAt: '2026-10-31T01:00:00.000Z',
          },
        },
      },
      async ({ q, calls }) => {
        const secret = q('[data-browser-proxy-secret-value="password"]') as HTMLInputElement | null;
        expect(secret?.type).toBe('password');
        await typeInto(secret, 'hunter2!');
        await click(q('[data-browser-proxy-secret-store="password"]') as HTMLButtonElement, 'store');
        await afterwards();
        const put = calls.find(call => call.path === '/v1/secrets');
        expect(put?.method).toBe('POST');
        expect(put?.body).toEqual({ name: 'PROXY_PASSWORD', value: 'hunter2!' });
        expect((q('[data-browser-proxy-secret-value="password"]') as HTMLInputElement).value).toBe('');
        expect((q('[data-browser-proxy-password]') as HTMLInputElement).value).toBe('PROXY_PASSWORD');
        expect(q('[data-setup-note="browser-proxy-secret-password"]')?.textContent).toContain(
          'Stored as PROXY_PASSWORD',
        );
        expect(JSON.stringify(document.body.innerHTML)).not.toContain('hunter2!');
      },
    );
  });

  it('files a pasted username under the name already in the box, and says when the machine refuses', async () => {
    await withTab(
      {
        machine: machineView({ browserProxy: null }),
        answers: { '/v1/secrets': new FyHttpError('This machine’s secret store is locked.', 403, 'forbidden') },
      },
      async ({ q, calls }) => {
        await typeInto(q('[data-browser-proxy-username]'), 'EDGE_USER');
        await typeInto(q('[data-browser-proxy-secret-value="username"]'), 'amy-edge-login');
        await click(q('[data-browser-proxy-secret-store="username"]') as HTMLButtonElement, 'store');
        await afterwards();
        expect(calls.find(call => call.path === '/v1/secrets')?.body).toEqual({
          name: 'EDGE_USER',
          value: 'amy-edge-login',
        });
        expect(q('[data-browser-proxy-secret-refusal]')?.textContent).toContain('secret store is locked');
        expect((q('[data-browser-proxy-secret-value="username"]') as HTMLInputElement).value).toBe('amy-edge-login');
      },
    );
  });

  it('will not store a value the secret store would refuse for being too short, and says why', async () => {
    await withTab({ machine: machineView({ browserProxy: null }) }, async ({ q, calls }) => {
      await typeInto(q('[data-browser-proxy-secret-value="username"]'), 'amy');
      expect((q('[data-browser-proxy-secret-store="username"]') as HTMLButtonElement).disabled).toBe(true);
      expect(q('[data-browser-proxy-secret-short]')?.textContent).toContain('at least 8 characters');
      expect(calls.some(call => call.path === '/v1/secrets')).toBe(false);
    });
  });

  it('is enabled for a saved proxy, also after the address is emptied, and disabled when offline', async () => {
    await withTab({ machine: withProxy() }, async ({ q }) => {
      expect(button(q).disabled).toBe(false);
      await typeInto(q('[data-browser-proxy-url]'), '');
      expect(button(q).disabled).toBe(false);
    });
    await withTab({ machine: withProxy(), online: false }, async ({ q }) => {
      expect(button(q).disabled).toBe(true);
    });
  });

  it('tests the saved proxy by sending an empty body, as a POST', async () => {
    await withTab(
      { machine: withProxy(), answers: { [BROWSER_PROXY_TEST_PATH]: reachable() } },
      async ({ q, calls }) => {
        await click(button(q), 'test');
        const sent = testCalls(calls);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.method).toBe('POST');
        expect(sent[0]?.headers['content-type']).toBe('application/json');
        expect(sent[0]?.body).toEqual({});
      },
    );
  });

  it('tests an emptied address as the saved proxy, still an empty body', async () => {
    await withTab(
      { machine: withProxy(), answers: { [BROWSER_PROXY_TEST_PATH]: reachable() } },
      async ({ q, calls }) => {
        await typeInto(q('[data-browser-proxy-url]'), '');
        await click(button(q), 'test');
        expect(testCalls(calls)[0]?.body).toEqual({});
      },
    );
  });

  it('tests an edited proxy by sending it, with secret references and no value', async () => {
    await withTab(
      { machine: withProxy(), answers: { [BROWSER_PROXY_TEST_PATH]: reachable({ tested: 'unsaved' }) } },
      async ({ q, calls }) => {
        await typeInto(q('[data-browser-proxy-url]'), 'socks5://other.example.test:1080');
        expect(q('[data-browser-proxy-test-hint]')?.textContent).toContain(
          'It tests what is typed above, saved or not.',
        );
        await click(button(q), 'test');
        const body = testCalls(calls)[0]?.body;
        expect(body).toEqual({
          proxy: {
            url: 'socks5://other.example.test:1080',
            bypass: ['*.internal.example.test'],
            username: ref('PROXY_USER'),
            password: ref('PROXY_PASSWORD'),
          },
        });
        expect(q('[data-browser-proxy-test-tested]')?.textContent).toBe(
          'Tested the proxy you are editing. It is not saved.',
        );
        // A test is not a save.
        expect(calls.some(call => call.path === '/v1/fleet/proposals')).toBe(false);
      },
    );
  });

  it('tests a new proxy on a machine with none saved', async () => {
    await withTab(
      {
        machine: machineView({ browserProxy: null }),
        answers: { [BROWSER_PROXY_TEST_PATH]: reachable({ tested: 'unsaved' }) },
      },
      async ({ q, calls }) => {
        await typeInto(q('[data-browser-proxy-url]'), 'http://proxy.example:8080');
        await click(button(q), 'test');
        expect(testCalls(calls)[0]?.body).toEqual({ proxy: { url: 'http://proxy.example:8080', bypass: [] } });
      },
    );
  });

  it('sends {} again when an edit is put back to what is saved', async () => {
    await withTab(
      { machine: withProxy(), answers: { [BROWSER_PROXY_TEST_PATH]: reachable() } },
      async ({ q, calls }) => {
        await typeInto(q('[data-browser-proxy-url]'), 'http://elsewhere.example.test:1');
        await typeInto(q('[data-browser-proxy-url]'), PROXY.url);
        await click(button(q), 'test');
        expect(testCalls(calls)[0]?.body).toEqual({});
      },
    );
  });

  it('shows a disabled button and “Testing the proxy…” while the test runs, then the answer', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const pending = new Promise<unknown>(resolve => {
      finish = resolve;
    });
    await withTab(
      { machine: withProxy(), answers: { [BROWSER_PROXY_TEST_PATH]: () => pending } },
      async ({ q, calls }) => {
        await click(button(q), 'test');
        expect(button(q).disabled).toBe(true);
        const busy = must(q('[data-browser-proxy-testing]'), 'the busy line');
        expect(busy.textContent).toBe('Testing the proxy…');
        expect(busy.getAttribute('role')).toBe('status');
        expect(q('[data-setup-note="browser-proxy-test"]')).toBeNull();
        await click(button(q), 'second click');
        expect(testCalls(calls)).toHaveLength(1);

        finish(reachable());
        await settle();
        expect(q('[data-browser-proxy-testing]')).toBeNull();
        expect(button(q).disabled).toBe(false);
        expect(q('[data-setup-note="browser-proxy-test"]')).not.toBeNull();
      },
    );
  });

  it('says Reachable with the round trip, the egress address and which proxy was tested', async () => {
    await withTab({ machine: withProxy(), answers: { [BROWSER_PROXY_TEST_PATH]: reachable() } }, async ({ q }) => {
      await click(button(q), 'test');
      const note = must(q('[data-setup-note="browser-proxy-test"]'), 'the result');
      expect(note.getAttribute('role')).toBe('status');
      expect(note.getAttribute('data-tone')).toBe('ok');
      expect(note.textContent).toContain('Reachable · 182 ms');
      expect(q('[data-browser-proxy-test-egress]')?.textContent).toBe('Traffic leaves via 203.0.113.7');
      expect(q('[data-browser-proxy-test-tested]')?.textContent).toBe('Tested the saved proxy.');
    });
  });

  it('words every error class in plain words, with the daemon’s sentence', async () => {
    expect(Object.keys(PROXY_ERROR_WORDS).sort()).toEqual([...BROWSER_PROXY_ERROR_CLASSES].sort());
    const expected: Readonly<Record<BrowserProxyErrorClass, string>> = {
      dns: 'Name not found (DNS)',
      connect: 'Connection failed',
      auth: 'Sign-in refused (407)',
      tls: 'Secure connection failed (TLS)',
      timeout: 'Timed out',
      proxy: 'Proxy refused',
      secret: 'Missing secret',
      'no-proxy': 'Nothing to test',
      other: 'Test failed',
    };
    for (const errorClass of BROWSER_PROXY_ERROR_CLASSES) {
      const message = `The daemon says ${errorClass}.`;
      await withTab(
        { machine: withProxy(), answers: { [BROWSER_PROXY_TEST_PATH]: unreachable(errorClass, message) } },
        async ({ q }) => {
          await click(button(q), 'test');
          const note = must(q('[data-setup-note="browser-proxy-test"]'), `the ${errorClass} result`);
          expect(note.getAttribute('data-tone')).toBe('err');
          expect(note.getAttribute('role')).toBe('status');
          expect(note.querySelector('p')?.textContent).toBe(expected[errorClass]);
          expect(q(`[data-browser-proxy-test-class="${errorClass}"]`)?.textContent).toBe(message);
        },
      );
    }
  });

  it('adds how long a failed test took, when the daemon says', async () => {
    await withTab(
      {
        machine: withProxy(),
        answers: { [BROWSER_PROXY_TEST_PATH]: { ...unreachable('timeout', 'No answer in time.'), roundTripMs: 8000 } },
      },
      async ({ q }) => {
        await click(button(q), 'test');
        expect(q('[data-setup-note="browser-proxy-test"]')?.textContent).toContain('Failed after 8000 ms.');
      },
    );
  });

  it('clears the result when the draft is edited, and drops an answer that arrives after the edit', async () => {
    let finish: (value: unknown) => void = () => undefined;
    let first = true;
    const slow = new Promise<unknown>(resolve => {
      finish = resolve;
    });
    await withTab(
      {
        machine: withProxy(),
        answers: {
          [BROWSER_PROXY_TEST_PATH]: () => {
            if (!first) return reachable();
            first = false;
            return slow;
          },
        },
      },
      async ({ q }) => {
        await click(button(q), 'test');
        await typeInto(q('[data-browser-proxy-bypass]'), '*.other.example.test');
        expect(q('[data-browser-proxy-testing]')).toBeNull();
        finish(reachable());
        await settle();
        expect(q('[data-setup-note="browser-proxy-test"]')).toBeNull();

        await click(button(q), 'test again');
        expect(q('[data-setup-note="browser-proxy-test"]')).not.toBeNull();
        await typeInto(q('[data-browser-proxy-username]'), 'OTHER_USER');
        expect(q('[data-setup-note="browser-proxy-test"]')).toBeNull();
      },
    );
  });

  it('clears the result when Keep puts the saved form back', async () => {
    await withTab({ machine: withProxy(), answers: { [BROWSER_PROXY_TEST_PATH]: reachable() } }, async ({ q }) => {
      await typeInto(q('[data-browser-proxy-url]'), 'http://elsewhere.example.test:1');
      await click(button(q), 'test');
      expect(q('[data-setup-note="browser-proxy-test"]')).not.toBeNull();
      await click(q('[data-browser-proxy-undo]'), 'keep');
      expect(q('[data-setup-note="browser-proxy-test"]')).toBeNull();
    });
  });

  it('words a refusal — the owner only — and shows nothing as a result', async () => {
    await withTab(
      {
        machine: withProxy(),
        answers: {
          [BROWSER_PROXY_TEST_PATH]: new FyHttpError(
            'Only the owner at this machine can test the proxy.',
            403,
            'owner_only',
          ),
        },
      },
      async ({ q }) => {
        await click(button(q), 'test');
        const note = must(q('[data-setup-note="browser-proxy-test"]'), 'the refusal');
        expect(note.getAttribute('data-tone')).toBe('warn');
        expect(note.textContent).toContain('The test didn’t run');
        expect(q('[data-browser-proxy-test-refusal]')?.textContent).toBe(
          'Only the owner at this machine can test the proxy.',
        );
        expect(button(q).disabled).toBe(false);
      },
    );
  });

  it('words a machine that cannot be reached', async () => {
    await withTab(
      { machine: withProxy(), answers: { [BROWSER_PROXY_TEST_PATH]: new Error('socket closed') } },
      async ({ q }) => {
        await click(button(q), 'test');
        expect(q('[data-browser-proxy-test-refusal]')?.textContent).toContain('This machine didn’t answer');
      },
    );
  });

  it('never shows a secret value: only the names it sends, and none in the result', async () => {
    await withTab(
      {
        machine: withProxy(),
        answers: {
          [BROWSER_PROXY_TEST_PATH]: unreachable('secret', 'The secret PROXY_PASSWORD is not stored on this machine.'),
        },
      },
      async ({ container, q }) => {
        await click(button(q), 'test');
        const shown = container.textContent ?? '';
        expect(shown).toContain('Missing secret');
        expect(shown).toContain('PROXY_PASSWORD is not stored');
        expect(shown).not.toContain('hunter2');
        expect((q('[data-browser-proxy-password]') as HTMLInputElement).value).toBe('PROXY_PASSWORD');
      },
    );
  });
});
