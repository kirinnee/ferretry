import { describe, expect, test } from 'bun:test';
import { render, run, runAsync } from '@ferretry/app/testing';
import { PageChanged } from '../../../../contract/index.ts';
import {
  browserPageForKey,
  type SessionBrowser,
  type SessionBrowserDependencies,
  sessionBrowserIdentity,
  useSessionBrowser,
} from '../../../../app/features/browser/use-session-browser.ts';
import type { BrowserSessionScope } from '../../../../app/lib/scope.ts';
import type { BrowserPageSummary, BrowserStatus } from '../../../../contract/wire/browser.ts';
import { PAGE_LIVE_POLL_MS, PAGE_POLL_MS } from '../../../../app/lib/page-feed.ts';
import { browserDaemon, recordingClient, refusal } from '../../../support/app/client.ts';
import { handPoll } from '../../../support/app/poll.ts';
import { daemonSessionScope } from '../../../support/app/scope.ts';

const STATUS = 'GET /v1/sessions/:sessionId/browser';
const ACT = 'POST /v1/sessions/:sessionId/browser';

const alphaId = { daemonId: 'alpha' };
const scope = daemonSessionScope(alphaId, 'sess-1');
const other = daemonSessionScope(alphaId, 'sess-2');

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

/** A daemon whose answers the test writes: `answer` is told the route and the session it was asked for. */
const fakeDaemon = (answer: (route: string, sessionId: string, body: unknown) => unknown) => {
  const { client, calls, heard } = recordingClient((route, init) =>
    answer(route, init?.params?.sessionId ?? '', init?.body),
  );
  return { daemon: browserDaemon(client, 'alpha'), calls, heard };
};

const settle = async (): Promise<void> => {
  await runAsync(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
};

function mount(daemon: ReturnType<typeof fakeDaemon>['daemon'], dependencies?: SessionBrowserDependencies) {
  const seen: { current: SessionBrowser | null } = { current: null };
  function Probe({ at }: { readonly at: BrowserSessionScope }) {
    seen.current = useSessionBrowser(at, daemon, dependencies);
    return null;
  }
  const renderer = render(<Probe at={scope} />);
  return {
    seen: seen as { current: SessionBrowser },
    renderer,
    rescope: (next: BrowserSessionScope) => run(() => renderer.update(<Probe at={next} />)),
  };
}

describe('useSessionBrowser', () => {
  test('should read the session status through the daemon client and keep its identity while nothing changed', async () => {
    // Arrange
    const { daemon, calls } = fakeDaemon(() => running([page('PAGE1', { name: 'app' })]));
    const { seen, renderer } = mount(daemon, { pollMs: 5 });
    await settle();
    const first = seen.current.status;

    // Act — a few polls answer the same pages.
    await runAsync(async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
    });

    // Assert
    expect(calls[0]).toEqual({ route: STATUS, init: { params: { sessionId: 'sess-1' } } });
    expect(calls.length).toBeGreaterThan(1);
    expect(first?.pages[0]?.name).toBe('app');
    expect(seen.current.status).toBe(first);
    renderer.unmount();
  });

  test('should leave the status unread when the daemon refuses, or answers for another session', async () => {
    const refused = mount(fakeDaemon(() => refusal(403, 'no browser grant')).daemon);
    const crossed = mount(fakeDaemon(() => running([page('PAGE1')], 'PAGE1', 'sess-9')).daemon);
    await settle();
    expect(refused.seen.current.status).toBeNull();
    expect(crossed.seen.current.status).toBeNull();
    refused.renderer.unmount();
    crossed.renderer.unmount();
  });

  test('should act through the browser route and show the status it answers', async () => {
    // Arrange
    let pages = [page('PAGE1', { name: 'app' })];
    const { daemon, calls } = fakeDaemon(route => {
      if (route === ACT) {
        pages = [...pages, page('PAGE2')];
        return { status: running(pages, 'PAGE2') };
      }
      return running(pages);
    });
    const { seen, renderer } = mount(daemon);
    await settle();

    // Act
    let answered: BrowserStatus | null = null;
    await runAsync(async () => {
      answered = await seen.current.act({ action: 'new-page' });
    });
    run(() => seen.current.activatePage('PAGE1'));
    await settle();

    // Assert
    expect(calls.filter(call => call.route === ACT).map(call => call.init?.body)).toEqual([
      { action: 'new-page' },
      { action: 'activate-page', pageId: 'PAGE1' },
    ]);
    expect((answered as BrowserStatus | null)?.pages).toHaveLength(2);
    expect(seen.current.status?.pages).toHaveLength(3);
    renderer.unmount();
  });

  test('should re-read after a refused act, and answer null', async () => {
    const { daemon, calls } = fakeDaemon(route =>
      route === ACT ? refusal(404, 'no such page') : running([page('PAGE1')]),
    );
    const { seen, renderer } = mount(daemon);
    await settle();
    let answered: BrowserStatus | null | undefined;
    await runAsync(async () => {
      answered = await seen.current.act({ action: 'close-page', pageId: 'PAGE9' });
    });
    await settle();
    expect(answered).toBeNull();
    expect(calls.map(call => call.route)).toEqual([STATUS, ACT, STATUS]);
    renderer.unmount();
  });

  test('should drop an act answered after the page moved to another session, or for another session', async () => {
    // Arrange
    let release: ((value: unknown) => void) | undefined;
    const { daemon } = fakeDaemon((route, sessionId) => {
      if (route === ACT) return new Promise(resolve => (release = resolve));
      return running([page(sessionId === 'sess-2' ? 'OTHER' : 'PAGE1')], undefined, sessionId);
    });
    const { seen, renderer, rescope } = mount(daemon);
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

  test('should re-read on this session’s page-changed events only, one read for a burst, with the poll as the safety net', async () => {
    // Arrange — timers the test moves by hand.
    const hand = handPoll();
    const { daemon, calls, heard } = fakeDaemon(() => running([page('PAGE1')]));
    const { renderer } = mount(daemon, { pollEnvironment: hand.environment });
    await settle();
    expect(hand.pending()).toEqual([PAGE_POLL_MS]);
    const initial = calls.length;

    // Act — another ferret's page reads nothing; a burst of this one's reads once; the poll reads once.
    run(() => heard.emit(PageChanged, { ferret: 'sess-2', page: 'PAGE9', change: 'opened' }));
    hand.advance(1_000);
    await settle();
    expect(calls.length).toBe(initial);
    run(() => {
      heard.emit(PageChanged, { ferret: 'sess-1', page: 'PAGE1', change: 'opened' });
      heard.emit(PageChanged, { ferret: 'sess-1', page: 'PAGE1', change: 'driving' });
    });
    hand.advance(1_000);
    await settle();
    expect(calls.length).toBe(initial + 1);
    hand.advance(PAGE_POLL_MS);
    await settle();

    // Assert
    expect(calls.length).toBe(initial + 2);
    run(() => renderer.unmount());
    expect(heard.listening()).toBe(0);
    expect(hand.pending()).toEqual([]);
  });

  test('SF3 should poll every ten seconds with no live feed, every two minutes while it is live, and never while hidden', async () => {
    // Arrange
    const hand = handPoll();
    const { daemon, calls, heard } = fakeDaemon(() => running([page('PAGE1')]));
    const { renderer } = mount(daemon, { pollEnvironment: hand.environment });
    await settle();

    // Act + Assert — no feed: a read every ten seconds (each settles before the next tick: a tick skips an in-flight read).
    for (let tick = 0; tick < 3; tick += 1) {
      hand.advance(PAGE_POLL_MS);
      await settle();
    }
    expect(calls.length).toBe(4);

    // The feed goes live: the next timer, once re-armed, waits two minutes.
    run(() => heard.live(true));
    const live = calls.length;
    hand.advance(PAGE_LIVE_POLL_MS - 1_000);
    await settle();
    expect(calls.length).toBe(live);
    hand.advance(1_000);
    await settle();
    expect(calls.length).toBe(live + 1);

    // Hidden: nothing, then one read when it is shown.
    hand.hide();
    hand.advance(PAGE_LIVE_POLL_MS * 3);
    await settle();
    expect(calls.length).toBe(live + 1);
    run(() => hand.show());
    await settle();
    expect(calls.length).toBe(live + 2);
    renderer.unmount();
  });
});

describe('useSessionBrowser behind a locked machine', () => {
  test('G95 a read parked behind the unlock prompt is not piled on by the next ticks, and the poll resumes once it settles', async () => {
    // Arrange — the daemon's answer waits for the unlock, as a locked machine's does.
    const hand = handPoll();
    let release: () => void = () => undefined;
    const unlocked = new Promise<void>(resolve => {
      release = resolve;
    });
    let parked = true;
    const { daemon, calls } = fakeDaemon(async () => {
      if (parked) await unlocked;
      return running([page('PAGE1')]);
    });
    const { renderer } = mount(daemon, { pollEnvironment: hand.environment });
    await settle();
    expect(calls.length).toBe(1);

    // Act — several ticks arrive while the first read is still parked.
    for (let tick = 0; tick < 4; tick += 1) {
      hand.advance(PAGE_POLL_MS);
      await settle();
    }

    // Assert — still one call: nothing piled up to be released as a burst on confirm.
    expect(calls.length).toBe(1);
    parked = false;
    release();
    await settle();
    hand.advance(PAGE_POLL_MS);
    await settle();
    expect(calls.length).toBe(2);
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
