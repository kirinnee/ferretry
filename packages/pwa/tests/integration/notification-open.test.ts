/**
 * A NOTIFICATION TAP OPENS THE CONVERSATION IT IS ABOUT, ON THE MACHINE THAT SENT IT — in real Chromium,
 * through the REAL built worker (`src/worker/service-worker.ts` → `sw.verified.js`), registered the way
 * the app registers it: once at `/` for the app's pages, and once per machine at `/push/<daemonId>/`
 * (`lib/push-scope.ts`), each titled with the reader's label for it.
 *
 * THE SITE is a signed release (`support/signed-release.ts`) whose app page is
 * `fixtures/notification-open-scene.tsx`: the app's own notification-open wiring — the entry point's
 * inbox, the real router, the real hook — showing the route the app would render. Every page load is
 * answered by the verified release, so `/d/<id>/…` reaches the app through the real `_redirects`.
 *
 * A PUSH is delivered to one machine's registration over DevTools (`ServiceWorker.deliverPushMessage`),
 * the event a push service raises. A TAP is a `notificationclick` dispatched in that worker on the
 * notification it actually showed. Chromium grants a worker the right to focus a window or open one
 * only inside a tap the READER made, and nothing a test can send is one, so in the worker's realm — and
 * only there — `WindowClient.focus` and `Clients.openWindow` are replaced with recorders that answer as
 * a granted call would. Everything else is the browser's own: which windows `Clients.matchAll` finds,
 * the message to the page, the page's reply, and `WindowClient.navigate`, which a machine's worker is
 * refused because it controls no page. A window the worker opens is then opened by the suite at
 * exactly the URL the worker asked for, which is what the browser would have done.
 *
 * What is proved, for a push from machine Beta while Alpha is also paired:
 *   - the app closed: the worker opens Beta's conversation, at the item;
 *   - the app open on Alpha's conversation, on Sessions, or on the same conversation at another item:
 *     the open window is brought forward and routed in the app — no second window, no reload;
 *   - several windows: the app window is the one routed, never the landing page beside it;
 *   - each machine's notification opens only its own machine's conversation;
 *   - a daemon that names no page (`url: '/'`, before #768 and `fy attention notify`) still opens the
 *     conversation the push is about; one about no conversation opens that machine's sessions;
 *   - a window still starting when the tap lands is routed once it is up, without a second window;
 *   - a window with no app wiring (an app too old to know the message) still ends on the conversation;
 *   - a notification the PAGE showed (the page watcher's needs-input / failed) opens its conversation;
 *   - a machine's push worker takes a new release only when the app asks for one — loading the app
 *     never re-checks it — which is why the app's reconcile asks at every start.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, Page, Worker } from 'playwright-core';
import { waitFor } from './support/wait-for';
import { sharedChromium } from './support/chromium.ts';
import { releaseKey, run, signedRelease } from './support/signed-release.ts';

const packageRoot = resolve(import.meta.dir, '../..');

const LANDING = '<!doctype html><meta charset="utf-8"><title>landing</title><p>landing</p>';
const APP = `<!doctype html><meta charset="utf-8"><title>app</title>
<div id="root"></div><script type="module" src="/app/scene.js"></script>`;

/** The two paired machines, by the id their scope carries and the reader's label for them. */
const MACHINES = {
  alpha: { scope: '/push/alpha/', script: '/sw.verified.js?machine=Alpha' },
  beta: { scope: '/push/beta/', script: '/sw.verified.js?machine=Beta' },
} as const;
type MachineName = keyof typeof MACHINES;

let workDirectory = '';
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let site = new Map<string, Uint8Array>();

const origin = (): string => `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'ferretry-notification-open-'));
  const scene = join(workDirectory, 'scene.js');
  run([
    'bun',
    'build',
    resolve(packageRoot, 'tests/integration/fixtures/notification-open-scene.tsx'),
    '--target',
    'browser',
    '--outfile',
    scene,
  ]);
  site = await signedRelease({
    directory: workDirectory,
    name: 'site',
    files: new Map<string, string | Uint8Array>([
      ['index.html', LANDING],
      ['app/index.html', APP],
      ['app/scene.js', new Uint8Array(await Bun.file(scene).arrayBuffer())],
    ]),
    identity: { commit: 'aaaaaaa', sequence: 1 },
    key: await releaseKey(workDirectory, 'key'),
  });
  browser = await sharedChromium();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      const { pathname } = new URL(request.url);
      // The rewrites `public/_redirects` names, for the loads the worker does not answer itself.
      const path =
        pathname.startsWith('/d/') || pathname === '/app/'
          ? 'app/index.html'
          : pathname === '/'
            ? 'index.html'
            : pathname.slice(1);
      const bytes = site.get(path);
      if (bytes === undefined) return new Response('not found', { status: 404 });
      const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.js') ? 'text/javascript' : 'text/plain';
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: { 'content-type': type, 'cache-control': 'no-store' },
      });
    },
  });
}, 240_000);

afterAll(async () => {
  await server?.stop(true);
  if (workDirectory !== '') await rm(workDirectory, { recursive: true, force: true });
});

const pause = (milliseconds: number) => new Promise(resolveTick => setTimeout(resolveTick, milliseconds));

/** What the scene shows: where the window is, and the route the app renders there. */
interface Shown {
  readonly path: string;
  readonly route: {
    readonly kind: string;
    readonly daemonId?: string;
    readonly sessionId?: string;
    /** The address the app rendered this route for: equal to `path` once the render has caught up. */
    readonly path: string;
    readonly attention: string | null;
    readonly entry: string;
  } | null;
  readonly opens: readonly string[];
}

const shown = async (page: Page): Promise<Shown> =>
  await page.evaluate(() => {
    const raw = document.querySelector<HTMLElement>('#route')?.dataset.route;
    return {
      path: `${location.pathname}${location.search}`,
      route: raw === undefined ? null : JSON.parse(raw),
      opens: (globalThis as unknown as { __notificationOpens?: string[] }).__notificationOpens ?? [],
    };
  });

/** Waits until the window shows `path` with the app mounted there, or answers what it shows instead. */
const settledOn = async (page: Page, path: string, timeout = 60_000): Promise<Shown> => {
  const deadline = Date.now() + timeout;
  let last = await shown(page).catch(() => null);
  while (Date.now() < deadline) {
    if (last?.path === path && last.route?.path === path) return last;
    await pause(50);
    last = await shown(page).catch(() => null);
  }
  return last ?? { path: 'unreadable', route: null, opens: [] };
};

/**
 * One browser profile with the app's worker installed at `/` and each machine's push worker at its own
 * scope — exactly the registrations `containerPushEnrolment` makes — and DevTools watching them.
 */
const profile = async () => {
  const context = await browser.newContext();
  await context.grantPermissions(['notifications'], { origin: origin() });
  const setup = await context.newPage();
  await setup.goto(`${origin()}/`);
  await setup.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.verified.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  });
  await setup.reload();
  await setup.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const cdp = await context.newCDPSession(setup);
  const seen = new Map<string, string>();
  cdp.on(
    'ServiceWorker.workerRegistrationUpdated',
    (event: { registrations: { registrationId: string; scopeURL: string; isDeleted?: boolean }[] }) => {
      for (const registration of event.registrations) {
        if (registration.isDeleted === true) seen.delete(registration.scopeURL);
        else seen.set(registration.scopeURL, registration.registrationId);
      }
    },
  );
  await cdp.send('ServiceWorker.enable');
  await setup.evaluate(async machines => {
    // The installed page enforces Trusted Types (`public/_headers`), so a registration takes only what
    // the app's `fy-worker` policy made, exactly as `lib/trusted-types.ts` makes it.
    const policy = (
      globalThis as unknown as {
        trustedTypes: { createPolicy(name: string, rules: object): { createScriptURL(url: string): string } };
      }
    ).trustedTypes.createPolicy('fy-worker', { createScriptURL: (url: string) => url });
    for (const { script, scope } of machines) {
      const registration = await navigator.serviceWorker.register(policy.createScriptURL(script), { scope });
      const worker = registration.installing ?? registration.waiting ?? registration.active;
      if (worker === null || worker.state === 'activated') continue;
      await new Promise<void>(resolveActive => {
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated') resolveActive();
        });
      });
    }
  }, Object.values(MACHINES));
  return { context, setup, cdp, seen };
};

type Profile = Awaited<ReturnType<typeof profile>>;

/**
 * Takes the setup tab out of the picture — a blank page is no window of this site, so the worker cannot
 * find it — while keeping the DevTools session that delivers pushes, which closing the tab would end.
 */
const retire = async (profile: Profile): Promise<void> => {
  await profile.setup.goto('about:blank');
};

const registrationOf = async (profile: Profile, scope: string): Promise<string> => {
  return await waitFor(
    () => profile.seen.get(`${origin()}${scope}`),
    `DevTools to report the registration at ${scope}`,
    {
      pollMs: 50,
    },
  );
};

/** How many notifications a machine's registration shows right now, asked of its own worker. */
const notificationsAt = async (profile: Profile, machine: MachineName): Promise<number> => {
  const { scope, script } = MACHINES[machine];
  const worker = await workerFor(profile, scope, script);
  return await worker.evaluate(
    async () =>
      (
        await (
          globalThis as unknown as { registration: { getNotifications(): Promise<unknown[]> } }
        ).registration.getNotifications()
      ).length,
  );
};

/**
 * Delivers one push to one machine's registration and waits until its notification is on screen. A
 * DevTools delivery is occasionally dropped (measured in `release-worker.test.ts`: 1 run in 9), so an
 * unseen push is sent again under the same tag, which replaces rather than adds.
 */
const push = async (profile: Profile, machine: MachineName, payload: Record<string, unknown>): Promise<void> => {
  const { scope } = MACHINES[machine];
  const send = async () =>
    await profile.cdp.send('ServiceWorker.deliverPushMessage', {
      origin: origin(),
      registrationId: await registrationOf(profile, scope),
      data: JSON.stringify({ version: 1, eventKey: `e-${Math.random()}`, body: 'b', count: 1, ...payload }),
    });
  await send();
  const deadline = Date.now() + 60_000;
  let resendAt = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await notificationsAt(profile, machine)) > 0) return;
    if (Date.now() >= resendAt) {
      resendAt = Date.now() + 3_000;
      await send();
    }
    await pause(50);
  }
  throw new Error(`the push to ${machine} was never shown`);
};

/** The worker serving `script`, started if the browser had stopped it. */
const workerFor = async (profile: Profile, scope: string, script: string): Promise<Worker> => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const found = profile.context.serviceWorkers().find(worker => worker.url() === `${origin()}${script}`);
    if (found !== undefined) return found;
    await profile.cdp.send('ServiceWorker.startWorker', { scopeURL: `${origin()}${scope}` }).catch(() => undefined);
    await pause(100);
  }
  throw new Error(`no running worker for ${script}`);
};

/**
 * The release mark a worker carries (`undefined` before the new release), or `null` once it is gone.
 *
 * A worker the browser stops stays in `serviceWorkers()` until it closes, and Playwright (1.62) never
 * settles an `evaluate` sent to it in that gap — not even with an error, so a `.catch` alone waits
 * forever. An update stops the worker it replaces a few milliseconds before closing it; a poll that
 * landed there hung the test for its whole two minutes. Its `close` answers instead.
 */
const releaseOf = async (worker: Worker): Promise<unknown> => {
  let gone = (): void => undefined;
  const closed = new Promise<null>(resolveGone => {
    gone = () => resolveGone(null);
    worker.once('close', gone);
  });
  try {
    return await Promise.race([
      worker.evaluate(() => (globalThis as unknown as { __release?: number }).__release).catch(() => null),
      closed,
    ]);
  } finally {
    worker.off('close', gone);
  }
};

/** What the worker did with the tap: the windows it brought forward, and the ones it opened. */
interface Tap {
  readonly focused: readonly string[];
  readonly opened: readonly string[];
}

/** Taps the notification `scope` shows, in its own worker. See the file's comment for the two recorders. */
const tap = async (profile: Profile, scope: string, script: string): Promise<() => Promise<Tap>> => {
  const worker = await workerFor(profile, scope, script);
  await worker.evaluate(async () => {
    const realm = globalThis as unknown as {
      __tap?: Tap & { focused: string[]; opened: string[]; pending: Promise<unknown>[] };
      registration: { getNotifications(): Promise<Notification[]> };
      dispatchEvent(event: Event): boolean;
    };
    if (realm.__tap === undefined) {
      const record = { focused: [] as string[], opened: [] as string[], pending: [] as Promise<unknown>[] };
      realm.__tap = record;
      const scopeGlobals = globalThis as unknown as {
        Clients: { prototype: { openWindow(url: string): Promise<unknown> } };
        WindowClient: { prototype: { focus(): Promise<unknown>; readonly url: string } };
        NotificationEvent: new (type: string, init: { notification: Notification }) => Event;
      };
      scopeGlobals.Clients.prototype.openWindow = async (url: string) => {
        record.opened.push(url);
        return null;
      };
      scopeGlobals.WindowClient.prototype.focus = async function (this: { url: string }) {
        record.focused.push(this.url);
        return this;
      };
    }
    const [notification] = await realm.registration.getNotifications();
    if (notification === undefined) throw new Error('nothing to tap');
    const Event = (
      globalThis as unknown as {
        NotificationEvent: new (type: string, init: { notification: Notification }) => Event;
      }
    ).NotificationEvent;
    const click = new Event('notificationclick', { notification }) as Event & {
      waitUntil(work: Promise<unknown>): void;
    };
    const record = realm.__tap;
    // The handler hands its whole job, the reply wait and the fallback included, to waitUntil: keeping
    // that promise lets the test wait for the handler to be DONE instead of guessing how long it takes.
    click.waitUntil = work => {
      record.pending.push(work);
    };
    realm.dispatchEvent(click);
  });
  return async () =>
    await worker.evaluate(async () => {
      const record = (globalThis as unknown as { __tap: Tap & { pending: Promise<unknown>[] } }).__tap;
      await Promise.allSettled(record.pending);
      return { focused: [...record.focused], opened: [...record.opened] };
    });
};

/** Opens the app at `path` in a window of its own, the way the reader left it. */
const appAt = async (profile: Profile, path: string, options: { held?: boolean; wired?: boolean } = {}) => {
  const page = await profile.context.newPage();
  await page.goto(`${origin()}/`);
  await page.evaluate(
    ({ held, wired }) => {
      localStorage.setItem('scene-hold', held ? '1' : '0');
      localStorage.setItem('scene-app', wired ? 'app' : 'none');
    },
    { held: options.held ?? false, wired: options.wired ?? true },
  );
  await page.goto(`${origin()}${path}`);
  if (options.held !== true && options.wired !== false) await settledOn(page, path);
  return page;
};

const ASK = {
  sessionId: 'mvb9x0-c0ffee01',
  kind: 'attention',
  title: '“Builder”: Pick a release window',
  tag: 'agenda-mvb9x0-c0ffee01',
  url: '/session/mvb9x0-c0ffee01?attention=A3',
} as const;
const BETA_ASK = '/d/beta/session/mvb9x0-c0ffee01?attention=A3';

describe('a notification tap opens its conversation on the machine that sent it', () => {
  test('with the app closed, the worker opens Beta’s conversation at the item', async () => {
    const browserProfile = await profile();
    await push(browserProfile, 'beta', ASK);
    // Every window of the app is gone; only the browser's notification is left.
    await retire(browserProfile);
    const tapped = await tap(browserProfile, MACHINES.beta.scope, MACHINES.beta.script);

    const { opened, focused } = await tapped();
    expect(focused).toEqual([]);
    expect(opened).toEqual([`${origin()}${BETA_ASK}`]);
    // The browser opens the window the worker asked for; the app starts there.
    const window = await browserProfile.context.newPage();
    await window.goto(opened[0] ?? '');
    const landed = await settledOn(window, BETA_ASK);
    expect(landed.route).toMatchObject({
      kind: 'session',
      daemonId: 'beta',
      sessionId: 'mvb9x0-c0ffee01',
      attention: 'A3',
    });
    await browserProfile.context.close();
  }, 120_000);

  test('with the app on Alpha’s conversation, routes that window to Beta’s — no second window, no reload', async () => {
    const browserProfile = await profile();
    const app = await appAt(browserProfile, '/d/alpha/session/mva1-aaaa0001');
    await retire(browserProfile);
    await app.evaluate(() => {
      (globalThis as unknown as { __sameDocument: boolean }).__sameDocument = true;
    });
    await push(browserProfile, 'beta', ASK);

    const tapped = await tap(browserProfile, MACHINES.beta.scope, MACHINES.beta.script);
    const landed = await settledOn(app, BETA_ASK);

    expect(landed.route).toMatchObject({ kind: 'session', daemonId: 'beta', attention: 'A3' });
    expect(landed.opens).toEqual([BETA_ASK]);
    expect(await tapped()).toEqual({ focused: [`${origin()}/d/alpha/session/mva1-aaaa0001`], opened: [] });
    // Routed in the app: the same document, not a reload.
    expect(await app.evaluate(() => (globalThis as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true);
    await browserProfile.context.close();
  }, 120_000);

  test('with the app on Sessions, opens Beta’s conversation', async () => {
    const browserProfile = await profile();
    const app = await appAt(browserProfile, '/d/alpha');
    await retire(browserProfile);
    await push(browserProfile, 'beta', ASK);

    const tapped = await tap(browserProfile, MACHINES.beta.scope, MACHINES.beta.script);
    const landed = await settledOn(app, BETA_ASK);

    expect(landed.route).toMatchObject({ kind: 'session', daemonId: 'beta', attention: 'A3' });
    expect((await tapped()).opened).toEqual([]);
    await browserProfile.context.close();
  }, 120_000);

  test('with the app on the same conversation at another item, moves to the tapped item', async () => {
    const browserProfile = await profile();
    const app = await appAt(browserProfile, '/d/beta/session/mvb9x0-c0ffee01?attention=A1');
    const before = await shown(app);
    await retire(browserProfile);
    await push(browserProfile, 'beta', ASK);

    const tapped = await tap(browserProfile, MACHINES.beta.scope, MACHINES.beta.script);
    const landed = await settledOn(app, BETA_ASK);

    expect(landed.route).toMatchObject({ kind: 'session', daemonId: 'beta', attention: 'A3' });
    // A new navigation, so the conversation re-targets even when the item is one it showed before.
    expect(landed.route?.entry).not.toBe(before.route?.entry);
    expect((await tapped()).opened).toEqual([]);
    await browserProfile.context.close();
  }, 120_000);

  test('with the landing page and the app both open, routes the app window and leaves the landing page', async () => {
    const browserProfile = await profile();
    const app = await appAt(browserProfile, '/d/alpha/session/mva1-aaaa0001');
    await retire(browserProfile);
    // The landing page is the newest window, and the one the reader looked at last.
    const landing = await browserProfile.context.newPage();
    await landing.goto(`${origin()}/`);
    await landing.bringToFront();
    await push(browserProfile, 'beta', ASK);

    const tapped = await tap(browserProfile, MACHINES.beta.scope, MACHINES.beta.script);
    const landed = await settledOn(app, BETA_ASK);

    expect(landed.route).toMatchObject({ kind: 'session', daemonId: 'beta', attention: 'A3' });
    expect(await landing.evaluate(() => location.pathname)).toBe('/');
    expect((await tapped()).opened).toEqual([]);
    await browserProfile.context.close();
  }, 120_000);

  test('each machine’s notification opens its own machine’s conversation, never the other’s', async () => {
    const browserProfile = await profile();
    const app = await appAt(browserProfile, '/d/alpha');
    await retire(browserProfile);
    await push(browserProfile, 'alpha', { ...ASK, url: '/session/mvb9x0-c0ffee01?attention=A2' });
    await push(browserProfile, 'beta', ASK);

    // The same session id on both machines: the machine that sent it is what decides.
    await tap(browserProfile, MACHINES.alpha.scope, MACHINES.alpha.script);
    const onAlpha = await settledOn(app, '/d/alpha/session/mvb9x0-c0ffee01?attention=A2');
    await tap(browserProfile, MACHINES.beta.scope, MACHINES.beta.script);
    const onBeta = await settledOn(app, BETA_ASK);

    expect(onAlpha.route).toMatchObject({ kind: 'session', daemonId: 'alpha', attention: 'A2' });
    expect(onBeta.route).toMatchObject({ kind: 'session', daemonId: 'beta', attention: 'A3' });
    await browserProfile.context.close();
  }, 120_000);

  /**
   * A DAEMON THAT NAMES NO PAGE. Before #768 every push carried `url: '/'`, an ask included, and
   * `fy attention notify` still did; a machine that has not been updated sends exactly that.
   */
  const UNNAMED_PAGES = [
    {
      name: 'an older daemon’s ask (url "/", a session)',
      payload: { sessionId: 'mvb9x0-c0ffee01', kind: 'question', title: 'Needs you', tag: 't', url: '/' },
      expected: '/d/beta/session/mvb9x0-c0ffee01',
    },
    {
      name: 'a conversation link with no item',
      payload: {
        sessionId: 'mvb9x0-c0ffee01',
        kind: 'failed',
        title: 'Failed',
        tag: 't',
        url: '/session/mvb9x0-c0ffee01',
      },
      expected: '/d/beta/session/mvb9x0-c0ffee01',
    },
    {
      name: 'a push about no conversation (kind only)',
      payload: { kind: 'device-paired', title: 'A new device was paired', tag: 't', url: '/' },
      expected: '/d/beta',
    },
  ] as const;
  // Three independent profiles, so the cases run side by side instead of paying each boot in turn.
  test('a daemon that names no page still opens the conversation the push is about, or that machine’s sessions', async () => {
    const outcomes = await Promise.allSettled(
      UNNAMED_PAGES.map(async ({ name, payload, expected }) => {
        const browserProfile = await profile();
        try {
          const app = await appAt(browserProfile, '/d/alpha/session/mva1-aaaa0001');
          await retire(browserProfile);
          await push(browserProfile, 'beta', payload);

          await tap(browserProfile, MACHINES.beta.scope, MACHINES.beta.script);
          const landed = await settledOn(app, expected);

          expect(landed.path).toBe(expected);
          expect(landed.route?.daemonId).toBe('beta');
        } catch (error) {
          if (error instanceof Error) error.message = `[${name} → ${expected}] ${error.message}`;
          throw error;
        } finally {
          await browserProfile.context.close();
        }
      }),
    );
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }, 120_000);

  test('a window still starting when the tap lands is routed once the app is up, without a second window', async () => {
    const browserProfile = await profile();
    // The store is still loading — the router is not mounted — for as long as the test holds it.
    const app = await appAt(browserProfile, '/d/alpha/session/mva1-aaaa0001', { held: true });
    await retire(browserProfile);
    await push(browserProfile, 'beta', ASK);

    const tapped = await tap(browserProfile, MACHINES.beta.scope, MACHINES.beta.script);
    // The worker is done — the entry point's inbox answered it, no second window — with nothing mounted yet.
    expect((await tapped()).opened).toEqual([]);
    expect((await shown(app)).route).toBeNull();
    await app.evaluate(() => (globalThis as unknown as { __mountScene: () => void }).__mountScene());
    const landed = await settledOn(app, BETA_ASK);

    expect(landed.route).toMatchObject({ kind: 'session', daemonId: 'beta', attention: 'A3' });
    await browserProfile.context.close();
  }, 120_000);

  test('a window that never answers (an app too old for the message) still ends on the conversation', async () => {
    const browserProfile = await profile();
    const stale = await appAt(browserProfile, '/d/alpha/session/mva1-aaaa0001', { wired: false });
    await retire(browserProfile);
    await push(browserProfile, 'beta', ASK);

    const tapped = await tap(browserProfile, MACHINES.beta.scope, MACHINES.beta.script);
    await tapped();

    // A machine's worker controls no page, so it may not navigate that window: it opens the
    // conversation in one of its own instead of leaving the reader where they were.
    expect(await stale.evaluate(() => location.pathname)).toBe('/d/alpha/session/mva1-aaaa0001');
    expect((await tapped()).opened).toEqual([`${origin()}${BETA_ASK}`]);
    await browserProfile.context.close();
  }, 120_000);

  test('a notification the page showed (needs input, failed) opens its conversation through the app’s worker', async () => {
    const browserProfile = await profile();
    const app = await appAt(browserProfile, '/d/alpha');
    await retire(browserProfile);
    // The page watcher shows through the app-wide registration, with the app's own path
    // (`notification-ledger.ts` → `notify.ts`).
    await app.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.showNotification('Needs input', {
        tag: 'session-needs',
        data: { url: '/d/beta/session/mvb9x0-c0ffee01', sessionId: 'mvb9x0-c0ffee01', eventKey: 'k', count: 1 },
      });
    });

    await tap(browserProfile, '/', '/sw.verified.js');
    const landed = await settledOn(app, '/d/beta/session/mvb9x0-c0ffee01');

    expect(landed.route).toMatchObject({ kind: 'session', daemonId: 'beta', sessionId: 'mvb9x0-c0ffee01' });
    await browserProfile.context.close();
  }, 120_000);

  /**
   * WHY A FIX TO THE WORKER NEVER REACHED A PHONE THAT WAS ALREADY ENROLLED. A browser re-checks a
   * worker when a page under its scope loads, and no page ever loads under `/push/<daemonId>/`: a new
   * release reaches the app's own worker on the next page load, and a machine's push worker keeps the
   * code it was enrolled with — the tap that opened the session list in a second window — until the
   * app asks for the update itself (`containerPushEnrolment.reconcile`, at every start).
   */
  test('a machine’s push worker takes a new release only when the app asks for it', async () => {
    const browserProfile = await profile();
    const original = site.get('sw.verified.js') ?? new Uint8Array();
    const marked = async (): Promise<readonly unknown[]> =>
      await Promise.all(
        browserProfile.context
          .serviceWorkers()
          .filter(worker => worker.url() === `${origin()}${MACHINES.beta.script}`)
          .map(releaseOf),
      );
    try {
      await workerFor(browserProfile, MACHINES.beta.scope, MACHINES.beta.script);
      // A new release of the worker is deployed.
      site.set('sw.verified.js', new Uint8Array([...original, ...new TextEncoder().encode('\nself.__release = 2;\n')]));

      // The app is opened, and used: every load re-checks the app's own worker, never the machine's.
      const app = await appAt(browserProfile, '/d/alpha');
      await app.reload();
      await settledOn(app, '/d/alpha');
      // A negative: nothing re-checks the machine's worker. The page load re-checked the app's own worker
      // in the same navigation, so the moment that one reports release 2 the loads' checks have run —
      // waiting for it replaces a guessed pause. The positive half below proves the update path works.
      await waitFor(
        async () => {
          const own = browserProfile.context
            .serviceWorkers()
            .filter(worker => worker.url() === `${origin()}/sw.verified.js`);
          return (await Promise.all(own.map(releaseOf))).includes(2) || undefined;
        },
        'the page load to re-check the app’s own worker',
        { pollMs: 50 },
      );
      const untouched = await marked();

      // What the app's reconcile does for every machine it is still paired with.
      await app.evaluate(async scope => {
        await (await navigator.serviceWorker.getRegistration(scope))?.update();
      }, MACHINES.beta.scope);
      await waitFor(async () => (await marked()).includes(2) || undefined, 'the machine worker to take release 2', {
        pollMs: 100,
      });

      expect(untouched.includes(2)).toBe(false);
      expect(await marked()).toContain(2);
    } finally {
      site.set('sw.verified.js', original);
      await browserProfile.context.close();
    }
  }, 120_000);
});
