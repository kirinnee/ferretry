/**
 * Browsers' app half, parity with today's Browser surfaces (docs/design/rebuild-parity.tsv, owner `browsers`, kind S).
 *
 * Each surface is proved by drawing it: the half the shell builds is mounted over a scripted daemon client and the test
 * reads what it drew. The views' own behaviour is in the ported suites under `tests/unit/app/`.
 */
import { describe, expect, it } from 'bun:test';
import { interact, mount, must, render } from '@ferretry/app/testing';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { createElement, type FunctionComponent, Suspense } from 'react';
import type { PanelProps, RendererProps, SettingsProps } from '@ferretry/kernel/manifest';
import app from '../../../app/index.ts';
import manifest from '../../../manifest.ts';
import type { BrowserAction, BrowserStatus } from '../../../app/lib/wire/browser.ts';
import { InAppBrowserSheet, InAppBrowserSurface } from '../../../app/features/browser/in-app-browser.tsx';
import type { BrowserDestination } from '../../../app/features/browser/in-app-browser-model.ts';
import { RemoteBrowserPageTabs } from '../../../app/features/browser/remote-browser-chrome.tsx';
import { withDocument } from '../../support/app/dom.ts';
import { recordingClient } from '../../support/app/client.ts';

await withDocument();

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
  });
};

const destination: BrowserDestination = {
  href: 'https://docs.example.test/getting-started',
  hostname: 'docs.example.test',
  scope: 'cross-origin',
};

const running = {
  sessionId: 'session-a',
  viewport: { width: 1280, height: 800 },
  viewers: 1,
  persistentProfile: true,
  idleTimeoutSeconds: 900,
  capacity: { running: 1, maximum: 3 },
  state: 'running',
  url: 'https://example.test/one',
  title: 'One',
  pages: [
    { id: 'p1', url: 'https://example.test/one', title: 'One' },
    { id: 'p2', url: 'https://other.test/two', title: 'Two' },
  ],
  activePageId: 'p1',
  pageState: 'ready',
  canGoBack: false,
  canGoForward: false,
} as unknown as BrowserStatus;

/** A daemon with no browser running and no configuration: every read answers the way a quiet machine does. */
const quiet = (): PluginClient =>
  recordingClient(route => {
    if (route === 'GET /v1/config/file')
      return { path: 'browsers.yaml', exists: true, text: 'mode: headless\n', etag: 'etag-1' };
    if (route === 'GET /v1/browser/state') return { state: 'stopped' };
    if (route === 'GET /v1/secrets') return { secrets: [] };
    return new Error(`no route ${route}`);
  }).client;

/** One of the half's surfaces, mounted as the shell mounts it: inside Suspense. */
const shown = <Props extends object>(component: unknown, props: Props) =>
  mount(createElement(Suspense, { fallback: null }, createElement(component as FunctionComponent<Props>, props)));

const half = () => {
  const built = app.build?.({ manifest, client: quiet() });
  return must(built, 'the built half');
};

describe('the Browsers app half draws the surfaces today’s Browser feature had', () => {
  it('S-0045 the Browser tab holds status, mode, proxy and the user agent', async () => {
    const built = half();
    const Tab = must(built.settings?.browser, 'the Browser settings tab');
    const view = await shown<SettingsProps>(Tab, {} as SettingsProps);
    await settle();
    expect(view.container.querySelector('[data-browser-tab]')).not.toBeNull();
    expect(view.container.querySelector('[data-browser-state]')).not.toBeNull();
    expect(view.container.querySelector('[data-browser-user-agent]')).not.toBeNull();
    expect(view.container.textContent).toContain('Browser mode');
    expect(view.container.textContent).toContain('Browser proxy');
    await view.unmount();
  });

  it('S-0043 Browser mode offers Headless and a Real window', async () => {
    const Tab = must(half().settings?.browser, 'the Browser settings tab');
    const view = await shown<SettingsProps>(Tab, {} as SettingsProps);
    await settle();
    expect(view.container.textContent).toContain('Headless');
    expect(view.container.textContent).toContain('Real window');
    await view.unmount();
  });

  it('S-0044 Browser proxy takes an address, a bypass list and credentials by secret name, and tests', async () => {
    const Tab = must(half().settings?.browser, 'the Browser settings tab');
    const view = await shown<SettingsProps>(Tab, {} as SettingsProps);
    await settle();
    expect(view.container.querySelector('[data-browser-proxy-url]')).not.toBeNull();
    expect(view.container.querySelector('[data-browser-proxy-bypass]')).not.toBeNull();
    expect(view.container.querySelector('[data-browser-proxy-test]')).not.toBeNull();
    expect(view.container.textContent).toContain('Username');
    expect(view.container.textContent).toContain('Password');
    await view.unmount();
  });

  it('S-0117 the link sheet previews a page in a sheet', async () => {
    const view = await mount(<InAppBrowserSheet destination={destination} open onClose={() => undefined} />);
    expect(document.body.textContent).toContain('Link preview');
    expect(document.body.textContent).toContain(destination.href);
    await view.unmount();
  });

  it('S-0118 the in-app surface names the address it shows and can be closed', async () => {
    let closed = 0;
    const view = await mount(
      <InAppBrowserSurface
        destination={destination}
        presentation="pane"
        titleId="surface-title"
        onClose={() => (closed += 1)}
      />,
    );
    expect(
      must(view.container.querySelector('[aria-label="URL being viewed"]'), 'the address rail').textContent,
    ).toContain('docs.example.test');
    await interact(() =>
      must(view.container.querySelector<HTMLElement>('[aria-label="Close browser pane"]'), 'close').click(),
    );
    expect(closed).toBe(1);
    await view.unmount();
  });

  it('S-0197 the page tabs list the daemon’s pages and dispatch page actions', () => {
    const actions: BrowserAction[] = [];
    const tree = render(<RemoteBrowserPageTabs status={running} onAction={action => actions.push(action)} />).root;
    const tabs = tree.findAll(node => node.props.role === 'tab');
    expect(tabs).toHaveLength(2);
    tabs[1]?.props.onClick();
    expect(actions).toEqual([{ action: 'activate-page', pageId: 'p2' }]);
  });

  it('S-0275 the unified surface is what the browser panel draws for a ferret', async () => {
    const Panel = must(half().panels?.browser, 'the browser panel');
    const view = await shown<PanelProps>(Panel, { subject: 'session-a' } as PanelProps);
    await settle();
    expect(view.container.querySelector('[data-browser-panel="session-a"]')).not.toBeNull();
    expect(view.container.querySelector('[aria-label="Browser controls"]')).not.toBeNull();
    await view.unmount();
  });

  it('S-0299 the browser feature is one panel in a ferret’s side pane and a %browser reference chip', async () => {
    const built = half();
    expect(manifest.ui?.panels?.map(entry => entry.id)).toEqual(['browser']);
    expect(built.panels?.browser?.({ subject: undefined } as never)).toBeNull();
    const Chip = must(built.renderers?.['reference:%browser'], 'the reference renderer');
    const view = await shown<RendererProps>(Chip, { value: 'agent-1' } as unknown as RendererProps);
    expect(view.container.textContent).toBe('%browser:agent-1');
    await view.unmount();
  });

  it('S-0451 Settings › Browser is a settings tab labelled Browser', () => {
    const tab = manifest.ui?.settings?.find(entry => entry.id === 'browser');
    expect(tab?.label).toBe('Browser');
  });

  it('S-0452 the side pane has a Browser panel the half builds', () => {
    expect(manifest.ui?.panels?.some(entry => entry.id === 'browser')).toBe(true);
    expect(typeof half().panels?.browser).toBe('function');
  });
});
