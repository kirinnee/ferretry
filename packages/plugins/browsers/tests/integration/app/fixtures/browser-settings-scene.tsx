/**
 * The browser entry for the Browser tab's visual tests (browser-mode, browser-proxy, browser-tab): the REAL tab, sections,
 * status line and banners over a scripted client — no daemon, no network. Every name, address and secret name is fake.
 *
 *   ?theme=<family>-<mode>&scene=mode|proxy|tab|status|firewall|invalid|proxy-test
 */

import { SetupSection } from '@ferretry/app/ui';
import { InstantSchema } from '@ferretry/std';
import { createRoot } from 'react-dom/client';
import type { CallClient } from '../../../../app/lib/clients.ts';
import { BrowserChallengeBanner } from '../../../../app/features/browser/browser-challenge-banner.tsx';
import { RemoteBrowserStatusBar } from '../../../../app/features/browser/remote-browser-chrome.tsx';
import { BrowserModeSection } from '../../../../app/features/settings/browser-mode-section.tsx';
import { BrowserProxySection } from '../../../../app/features/settings/browser-proxy-section.tsx';
import { BrowserProxyTestBlock } from '../../../../app/features/settings/browser-proxy-test-block.tsx';
import type { ProxyTestShown } from '../../../../app/features/settings/browser-proxy-test-result.tsx';
import { BrowserStateLine } from '../../../../app/features/settings/browser-state-line.tsx';
import { BrowserTab } from '../../../../app/features/settings/browser-tab.tsx';
import type { BrowserStateView } from '../../../../contract/index.ts';
import type { BrowserStatus } from '../../../../contract/wire/browser.ts';
import { BROWSER_PROXY_ERROR_CLASSES, type BrowserProxyTestResult } from '../../../../contract/wire.ts';

type BrowserProxyErrorClass = (typeof BROWSER_PROXY_ERROR_CLASSES)[number];
const STARTED = InstantSchema.parse('2026-10-30T08:00:00.000Z');

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('scene') ?? 'tab';

const PROXY = {
  url: 'http://proxy.example.test:8080',
  bypass: ['*.internal.example.test', '10.0.0.0/8'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference, exactly as a file holds one
  username: '${secret:PROXY_USER}',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference, exactly as a file holds one
  password: '${secret:PROXY_PASSWORD}',
};
const CONFIG_TEXT = `mode: headless
proxy:
  url: ${PROXY.url}
  bypass: ['${PROXY.bypass[0]}', '${PROXY.bypass[1]}']
  username: ${PROXY.username}
  password: ${PROXY.password}
`;

/** A client with no daemon behind it: what each route answers is this table. */
const scripted = (state: BrowserStateView): CallClient => ({
  call: (async (route: string) => {
    if (route === 'GET /v1/config/file') return { path: 'browsers.yaml', exists: true, text: CONFIG_TEXT, etag: 'e1' };
    if (route === 'GET /v1/browser/state') return state;
    if (route === 'GET /v1/grants')
      return { capabilities: [{ capability: 'fleet', configure: true, configureRefusal: 'granted' }] };
    if (route === 'GET /v1/secrets') return { health: 'ready', secrets: [] };
    throw new Error(`the picture asks nothing of ${route}`);
  }) as CallClient['call'],
});

const RUNNING: BrowserStateView = {
  state: 'running',
  startedAt: STARTED,
  proxy: { url: PROXY.url, authenticated: true, bypassCount: 2 },
};
const firewall = (state: 'missing' | 'stale' | 'failed' | 'unverified', detail: string): BrowserStateView => ({
  state: 'stopped',
  firewall: { state, detail },
});

const STATUS_VIEWS: readonly BrowserStateView[] = [
  RUNNING,
  { state: 'stopped' },
  { state: 'running', startedAt: STARTED },
];
const FIREWALL_VIEWS: readonly BrowserStateView[] = [
  firewall(
    'missing',
    'the loopback firewall is missing: ask the host admin to add `user 1001` to /etc/ferretry/loopback-firewall.conf',
  ),
  firewall(
    'stale',
    'the loopback firewall is stale: ask the host admin to add `user 1001 20004 20005 20006` to /etc/ferretry/loopback-firewall.conf',
  ),
  firewall(
    'failed',
    'the loopback firewall failed its check: another user on this host could connect to this account’s browser ports',
  ),
  firewall('unverified', 'the 5-minute firewall check is not running: ask the host admin to enable the verify timer'),
];

/** Only `changes` is read while nothing is pending: the state a settled section shows. */
const OPEN = { kind: 'open' } as const;
const saved = async () => ({ kind: 'saved' }) as const;

const status = {
  sessionId: 'session-a',
  viewport: { width: 1280, height: 800 },
  viewers: 1,
  persistentProfile: true,
  idleTimeoutSeconds: 900,
  capacity: { running: 1, maximum: 3 },
  state: 'running',
  url: 'https://example.test/one',
  title: 'One',
  pages: [{ id: 'p1', url: 'https://example.test/one', title: 'One' }],
  activePageId: 'p1',
  pageState: 'ready',
  canGoBack: false,
  canGoForward: false,
  proxy: { url: PROXY.url, authenticated: true, bypassCount: 2 },
} as BrowserStatus;

const SAVED_HINT = 'Tries one request through the proxy from this machine.';
const failure = (errorClass: BrowserProxyErrorClass, message: string): BrowserProxyTestResult => ({
  reachable: false,
  tested: 'saved',
  errorClass,
  message,
});
const FAILURES: Readonly<Record<BrowserProxyErrorClass, string>> = {
  dns: 'The proxy’s name, proxy.example.test, was not found.',
  connect: 'Nothing is listening at proxy.example.test:8080.',
  auth: 'The proxy refused the stored sign-in. Check the secrets PROXY_USER and PROXY_PASSWORD.',
  tls: 'The proxy’s certificate was not accepted.',
  timeout: 'The proxy did not answer in 10 seconds.',
  proxy: 'The proxy answered, but would not carry the request.',
  secret: 'The secret PROXY_PASSWORD is not stored on this machine.',
  'no-proxy': 'No proxy is saved on this machine, and none was typed.',
  other: 'The test stopped for a reason the daemon could not name.',
};
const block = (shown: ProxyTestShown | null, testing = false) => (
  <BrowserProxyTestBlock disabled={false} testing={testing} hint={SAVED_HINT} shown={shown} onTest={() => undefined} />
);
const reachable = (tested: 'saved' | 'unsaved', roundTripMs: number, egressIp: string): ProxyTestShown => ({
  kind: 'result',
  result: {
    reachable: true,
    tested,
    roundTripMs,
    egressIp,
    message: 'The proxy answered and the test endpoint saw its address.',
  },
});

const gallery = (
  <>
    <SetupSection title="Test proxy · busy" name="shot-busy">
      {block(null, true)}
    </SetupSection>
    <SetupSection title="Test proxy · reachable, saved proxy" name="shot-reachable-saved">
      {block(reachable('saved', 182, '203.0.113.7'))}
    </SetupSection>
    <SetupSection title="Test proxy · reachable, unsaved edit" name="shot-reachable-unsaved">
      {block(reachable('unsaved', 96, '2001:db8:85a3::8a2e:370:7334'))}
    </SetupSection>
    {BROWSER_PROXY_ERROR_CLASSES.map(errorClass => (
      <SetupSection key={errorClass} title={`Test proxy · ${errorClass}`} name={`shot-${errorClass}`}>
        {block({ kind: 'result', result: failure(errorClass, FAILURES[errorClass]) })}
      </SetupSection>
    ))}
    <SetupSection title="Test proxy · refused" name="shot-refused">
      {block({ kind: 'refused', sentence: 'Only the owner at this machine can test the proxy.' })}
    </SetupSection>
  </>
);

const lines = (views: readonly BrowserStateView[]) =>
  views.map(view => <BrowserStateLine key={JSON.stringify(view)} client={scripted(view)} savedProxy />);

const body = (): React.ReactNode => {
  switch (scene) {
    case 'mode':
      return (
        <>
          <BrowserModeSection machineName="studio" authority={OPEN} mode="window" save={saved} />
          <section className="flex min-w-0 flex-col overflow-hidden rounded-panel border border-border bg-surface">
            <BrowserChallengeBanner challenge={{ provider: 'cloudflare' }} />
            <div className="flex h-48 items-center justify-center bg-code-bg text-meta text-muted">
              Just a moment… (the page, as streamed)
            </div>
          </section>
        </>
      );
    case 'proxy':
      return (
        <>
          <BrowserProxySection
            client={scripted(RUNNING)}
            machineName="studio"
            authority={OPEN}
            saved={PROXY}
            save={saved}
          />
          <section className="flex min-w-0 flex-col overflow-hidden rounded-panel border border-border bg-surface p-panel">
            <RemoteBrowserStatusBar status={status} connection="connected" />
          </section>
        </>
      );
    case 'status':
      return lines(STATUS_VIEWS);
    case 'firewall':
      return lines(FIREWALL_VIEWS);
    case 'invalid':
      return (
        <BrowserProxySection
          client={scripted({ state: 'stopped' })}
          machineName="studio"
          authority={OPEN}
          saved={null}
          save={saved}
        />
      );
    case 'proxy-test':
      return gallery;
    default:
      return <BrowserTab client={scripted(RUNNING)} />;
  }
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <div className="flex min-w-0 flex-col gap-5 bg-bg p-panel" data-scene={scene}>
    {body()}
  </div>,
);
