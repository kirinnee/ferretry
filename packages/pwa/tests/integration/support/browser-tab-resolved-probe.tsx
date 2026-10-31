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
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
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
// The form as it is when a real user name and password were typed where secret NAMES go, then Test proxy pressed.
const invalidClient: FleetClient = {
  request: async <T,>(path: string, schema: z.ZodType<T>): Promise<T> => {
    if (path !== BROWSER_STATE_PATH) throw new Error(`the picture asks nothing of ${path}`);
    return schema.parse({ state: 'stopped' });
  },
};
const invalid = await mount(
  <BrowserTab
    connection={connection}
    machineName="studio"
    machine={{ ...machine, browserProxy: null }}
    online
    checking={false}
    onRetry={() => undefined}
    createClient={async () => invalidClient}
  />,
);
await settle();
const field = (selector: string): HTMLInputElement =>
  must(invalid.container.querySelector<HTMLInputElement>(selector), selector);
await typeInto(field('[data-browser-proxy-url]'), 'socks5://proxy.example.test:1080');
await typeInto(field('[data-browser-proxy-username]'), 'amy.example');
await typeInto(field('[data-browser-proxy-password]'), 'correct-horse');
await click(must(invalid.container.querySelector('[data-browser-proxy-test]'), 'the Test proxy button'));
await settle();
must(invalid.container.querySelector('[data-browser-proxy-test-refusal]'), 'the invalid-form message');
const proxy = must(invalid.container.querySelector('[data-setup-section="browser-proxy"]'), 'the proxy section');
out['invalid-form'] = { tab: invalid.container.innerHTML, status: proxy.outerHTML };
await invalid.unmount();
console.log(JSON.stringify(out));
process.exit(0);
