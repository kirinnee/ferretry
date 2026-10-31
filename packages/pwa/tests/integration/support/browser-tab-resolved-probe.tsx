/**
 * Run as its own process by `browser-tab.visual.test.tsx`: mounts the REAL Browser tab in happy-dom against a
 * scripted daemon, waits until the status line has read `GET /v1/browser/state`, and prints each state's markup.
 * A child keeps happy-dom's process-wide globals out of the browser-driving test. Every name and address is fake.
 */
import { BROWSER_STATE_PATH, type BrowserStateView, type FleetMachineView } from '@ferretry/protocol';
import type { z } from 'zod';
import type { FleetClient } from '../../../src/features/fleet/fleet-client.ts';
import { BrowserTab } from '../../../src/features/fleet/machine/browser-tab.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../../support/dom.ts';

const machine: FleetMachineView = {
  name: 'studio',
  format: 'version-2',
  setUp: true,
  agentPermissions: 'auto',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  browserMode: 'headless',
  browserProxy: {
    url: 'http://proxy.example.test:8080',
    bypass: ['*.internal.example.test', '10.0.0.0/8'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference, exactly as a file holds one
    username: '${secret:PROXY_USER}',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference, exactly as a file holds one
    password: '${secret:PROXY_PASSWORD}',
  },
  tools: [],
  runtimeCount: 1,
  runningSessions: 0,
  authority: { mayApply: true, applyRefusal: 'granted' },
};

const connection = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 't' });

const states: Readonly<Record<string, BrowserStateView>> = {
  'running-via-proxy': {
    state: 'running',
    startedAt: '2026-10-30T08:00:00.000Z',
    proxy: { url: 'http://proxy.example.test:8080', authenticated: true, bypassCount: 2 },
  },
  stopped: { state: 'stopped' },
  'running-direct': { state: 'running', startedAt: '2026-10-30T08:00:00.000Z' },
};

const typeInto = async (field: HTMLInputElement, value: string): Promise<void> => {
  await interact(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const click = async (element: Element): Promise<void> => {
  await interact(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
};

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });
};

const out: Record<string, { tab: string; status: string }> = {};
for (const [name, view] of Object.entries(states)) {
  const client: FleetClient = {
    request: async <T,>(path: string, schema: z.ZodType<T>): Promise<T> => {
      if (path !== BROWSER_STATE_PATH) throw new Error(`the picture asks nothing of ${path}`);
      return schema.parse(view);
    },
  };
  const shown = await mount(
    <BrowserTab
      connection={connection}
      machineName="studio"
      machine={machine}
      online
      checking={false}
      onRetry={() => undefined}
      createClient={async () => client}
    />,
  );
  await settle();
  const line = must(shown.container.querySelector('[data-browser-state]'), 'the status line');
  const resolved = line.getAttribute('data-browser-state');
  if (resolved === 'reading' || resolved === 'unavailable') throw new Error(`the status line stayed "${resolved}"`);
  const section = must(line.closest('section'), 'the status section');
  out[name] = { tab: shown.container.innerHTML, status: section.outerHTML };
  await shown.unmount();
}
// The credential form through the real controls: empty, stored, refused for being short, and a mistyped secret name.
const SUMMARY = {
  name: 'PROXY_PASSWORD',
  createdAt: '2026-10-31T01:00:00.000Z',
  updatedAt: '2026-10-31T01:00:00.000Z',
};
const formClient: FleetClient = {
  request: async <T,>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
    if (path === BROWSER_STATE_PATH) return schema.parse({ state: 'stopped' });
    if (path === '/v1/secrets') {
      return schema.parse(
        init?.method === 'POST'
          ? { ...SUMMARY, name: JSON.parse(String(init.body)).name }
          : { v: 1, health: 'ready', secrets: [], references: [] },
      );
    }
    throw new Error(`the picture asks nothing of ${path}`);
  },
};
const form = async (name: string, steps: (root: HTMLElement) => Promise<void>): Promise<void> => {
  const shown = await mount(
    <BrowserTab
      connection={connection}
      machineName="studio"
      machine={{ ...machine, browserProxy: null }}
      online
      checking={false}
      onRetry={() => undefined}
      createClient={async () => formClient}
    />,
  );
  await settle();
  await steps(shown.container);
  await settle();
  const proxy = must(shown.container.querySelector('[data-setup-section="browser-proxy"]'), 'the proxy section');
  out[name] = { tab: shown.container.innerHTML, status: proxy.outerHTML };
  await shown.unmount();
};
const input = (root: HTMLElement, selector: string): HTMLInputElement =>
  must(root.querySelector<HTMLInputElement>(selector), selector);
const press = async (root: HTMLElement, selector: string): Promise<void> =>
  click(must(root.querySelector(selector), selector));
const ADDRESS = 'socks5://proxy.example.test:1080';
await form('form-empty', async root => {
  await typeInto(input(root, '[data-browser-proxy-url]'), ADDRESS);
});
await form('form-stored', async root => {
  await typeInto(input(root, '[data-browser-proxy-url]'), ADDRESS);
  await typeInto(input(root, '[data-browser-proxy-credential-value="username"]'), 'amy.example');
  await press(root, '[data-browser-proxy-credential-save="username"]');
  await settle();
  await typeInto(input(root, '[data-browser-proxy-credential-value="password"]'), 'correct-horse');
  await press(root, '[data-browser-proxy-credential-save="password"]');
  await settle();
  must(root.querySelector('[data-browser-proxy-credential-stored="password"]'), 'the stored password');
});
await form('form-short', async root => {
  await typeInto(input(root, '[data-browser-proxy-url]'), ADDRESS);
  await typeInto(input(root, '[data-browser-proxy-credential-value="username"]'), 'amy');
  await press(root, '[data-browser-proxy-credential-save="username"]');
  must(root.querySelector('[data-browser-proxy-credential-problem="username"]'), 'the short-value error');
});
await form('invalid-form', async root => {
  await typeInto(input(root, '[data-browser-proxy-url]'), ADDRESS);
  await press(root, '[data-browser-proxy-expert]');
  await typeInto(input(root, '[data-browser-proxy-username]'), 'amy.example');
  await typeInto(input(root, '[data-browser-proxy-password]'), 'correct-horse');
  await press(root, '[data-browser-proxy-test]');
  must(root.querySelector('[data-browser-proxy-test-refusal]'), 'the invalid-form message');
});
console.log(JSON.stringify(out));
process.exit(0);
