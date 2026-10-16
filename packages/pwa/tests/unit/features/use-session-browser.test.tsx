import { describe, expect, test } from 'bun:test';
import type { BrowserPageSummary, BrowserStatus, IFyApiClient } from '@ferretry/protocol';
import type { z } from 'zod';
import {
  browserPageForKey,
  type SessionBrowser,
  type SessionBrowserDependencies,
  sessionBrowserIdentity,
  useSessionBrowser,
} from '../../../src/features/browser/use-session-browser.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import { render, run, runAsync } from '../../support/react.ts';

const alpha = daemonConnection({ daemonId: 'alpha', baseUrl: 'https://alpha.example.test', deviceId: 'alpha-token' });
const scope = daemonSessionScope(alpha, 'sess-1');
const other = daemonSessionScope(alpha, 'sess-2');

const page = (id: string, extra: Partial<BrowserPageSummary> = {}): BrowserPageSummary => ({
  id,
  url: `https://example.test/${id}`,
  title: id,
  ...extra,
});

const running = (pages: readonly BrowserPageSummary[], active = pages[0]?.id, sessionId = 'sess-1'): BrowserStatus =>
  ({
    sessionId,
    state: 'running',
    pages: [...pages],
    activePageId: active,
    url: pages[0]?.url,
    title: pages[0]?.title,
    pageState: 'ready',
    canGoBack: false,
    canGoForward: false,
    viewport: { width: 1280, height: 800 },
    viewers: 1,
    persistentProfile: true,
    idleTimeoutSeconds: 900,
    capacity: { running: pages.length, maximum: 60 },
  }) as BrowserStatus;

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

const fakeClient = (answer: (call: Call) => unknown) => {
  const calls: Call[] = [];
  const client: SessionBrowserDependencies['client'] = async () =>
    ({
      request: async <T,>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
        const call: Call = {
          path,
          method: init?.method ?? 'GET',
          ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
        };
        calls.push(call);
        const value = await answer(call);
        if (value instanceof Error) throw value;
        return schema.parse(value);
      },
    }) satisfies Pick<IFyApiClient, 'request'>;
  return { client, calls };
};

const settle = async (): Promise<void> => {
  await runAsync(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

function mount(dependencies: SessionBrowserDependencies | undefined) {
  const seen: { current: SessionBrowser | null } = { current: null };
  function Probe({ at }: { readonly at: DaemonSessionScope }) {
    seen.current = useSessionBrowser(at, alpha, dependencies);
    return null;
  }
  const renderer = render(<Probe at={scope} />);
  return {
    seen: seen as { current: SessionBrowser },
    renderer,
    rescope: (next: DaemonSessionScope) => run(() => renderer.update(<Probe at={next} />)),
  };
}

describe('useSessionBrowser', () => {
  test('should read nothing and act on nothing without a daemon client', async () => {
    const { seen, renderer } = mount(undefined);
    expect(seen.current.status).toBeNull();
    expect(await seen.current.act({ action: 'new-page' })).toBeNull();
    expect(seen.current.activatePage('PAGE1')).toBeUndefined();
    renderer.unmount();
  });

  test('should read the session status through the daemon client and keep its identity while nothing changed', async () => {
    // Arrange
    const { client, calls } = fakeClient(() => running([page('PAGE1', { name: 'app' })]));
    const { seen, renderer } = mount({ client, pollMs: 5 });
    await settle();
    const first = seen.current.status;

    // Act — a few polls answer the same pages.
    await runAsync(async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
    });

    // Assert
    expect(calls[0]).toEqual({ method: 'GET', path: '/v1/sessions/sess-1/browser' });
    expect(calls.length).toBeGreaterThan(1);
    expect(first?.pages[0]?.name).toBe('app');
    expect(seen.current.status).toBe(first);
    renderer.unmount();
  });

  test('should leave the status unread when the daemon refuses, or answers for another session', async () => {
    const refused = mount({ client: fakeClient(() => new Error('403')).client });
    const crossed = mount({ client: fakeClient(() => running([page('PAGE1')], 'PAGE1', 'sess-9')).client });
    await settle();
    expect(refused.seen.current.status).toBeNull();
    expect(crossed.seen.current.status).toBeNull();
    refused.renderer.unmount();
    crossed.renderer.unmount();
  });

  test('should act through the browser route and show the status it answers', async () => {
    // Arrange
    let pages = [page('PAGE1', { name: 'app' })];
    const { client, calls } = fakeClient(call => {
      if (call.method === 'POST') {
        pages = [...pages, page('PAGE2')];
        return { status: running(pages, 'PAGE2') };
      }
      return running(pages);
    });
    const { seen, renderer } = mount({ client });
    await settle();

    // Act
    let answered: BrowserStatus | null = null;
    await runAsync(async () => {
      answered = await seen.current.act({ action: 'new-page' });
    });
    run(() => seen.current.activatePage('PAGE1'));
    await settle();

    // Assert
    expect(calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([
      { action: 'new-page' },
      { action: 'activate-page', pageId: 'PAGE1' },
    ]);
    expect((answered as BrowserStatus | null)?.pages).toHaveLength(2);
    expect(seen.current.status?.pages).toHaveLength(3);
    renderer.unmount();
  });

  test('should re-read after a refused act, and answer null', async () => {
    const { client, calls } = fakeClient(call =>
      call.method === 'POST' ? new Error('no such page') : running([page('PAGE1')]),
    );
    const { seen, renderer } = mount({ client });
    await settle();
    let answered: BrowserStatus | null | undefined;
    await runAsync(async () => {
      answered = await seen.current.act({ action: 'close-page', pageId: 'PAGE9' });
    });
    await settle();
    expect(answered).toBeNull();
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST', 'GET']);
    renderer.unmount();
  });

  test('should drop an act answered after the page moved to another session, or for another session', async () => {
    // Arrange
    let release: ((value: unknown) => void) | undefined;
    const { client } = fakeClient(call => {
      if (call.method === 'POST') return new Promise(resolve => (release = resolve));
      return running([page(call.path.includes('sess-2') ? 'OTHER' : 'PAGE1')], undefined, call.path.split('/')[3]);
    });
    const { seen, renderer, rescope } = mount({ client });
    await settle();
    let late: Promise<BrowserStatus | null> | undefined;
    run(() => {
      late = seen.current.act({ action: 'new-page' });
    });
    await settle();

    // Act
    rescope(other);
    await settle();
    release?.({ status: running([page('PAGE1'), page('PAGE2')]) });

    // Assert
    expect(await late).toBeNull();
    expect(seen.current.status?.pages.map(entry => entry.id)).toEqual(['OTHER']);

    // An answer naming another session is not this session's either.
    let crossed: Promise<BrowserStatus | null> | undefined;
    run(() => {
      crossed = seen.current.act({ action: 'new-page' });
    });
    await settle();
    release?.({ status: running([page('X')], 'X', 'sess-9') });
    expect(await crossed).toBeNull();
    renderer.unmount();
  });
});

describe('browser page helpers', () => {
  test('should find a page by its name or its id', () => {
    const status = running([page('PAGE1', { name: 'app' }), page('PAGE2')]);
    expect(browserPageForKey(status, 'app')?.id).toBe('PAGE1');
    expect(browserPageForKey(status, 'PAGE2')?.id).toBe('PAGE2');
    expect(browserPageForKey(status, 'docs')).toBeUndefined();
    expect(browserPageForKey(null, 'app')).toBeUndefined();
  });

  test('should key the status on what a reader sees, not on what merely ticks', () => {
    const base = running([page('PAGE1', { name: 'app' })]);
    expect(sessionBrowserIdentity(null)).toBe('unread');
    expect(sessionBrowserIdentity({ ...base, viewers: 4 } as BrowserStatus)).toBe(sessionBrowserIdentity(base));
    expect(sessionBrowserIdentity(running([page('PAGE1', { name: 'app', incognito: true })]))).not.toBe(
      sessionBrowserIdentity(base),
    );
    expect(
      sessionBrowserIdentity(running([page('PAGE1', { name: 'app', ownerSessionId: 's', ownerName: 'Hadi' })])),
    ).not.toBe(sessionBrowserIdentity(base));
    expect(
      sessionBrowserIdentity({
        sessionId: 'sess-1',
        state: 'stopped',
        pages: [],
        viewport: { width: 1, height: 1 },
        viewers: 0,
        persistentProfile: true,
        idleTimeoutSeconds: 900,
        capacity: { running: 0, maximum: 60 },
      } as BrowserStatus),
    ).toContain('stopped');
  });
});
