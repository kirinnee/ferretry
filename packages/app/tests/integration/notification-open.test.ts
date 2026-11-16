/**
 * A NOTIFICATION TAP OPENS THE PAGE IT IS ABOUT, ON THE MACHINE THAT SENT IT — in real Chromium, through the REAL built
 * worker (`src/worker/service-worker.ts` → `sw.verified.js`), registered the way the app registers it: once at `/` for the
 * app's pages, and once per machine at `/push/<daemonId>/` titled with the reader's label for it (S6; ported from v4's
 * `packages/pwa/tests/integration/notification-open.test.ts`).
 *
 * THE SITE is a signed release (`support/browser/signed-release.ts`) whose app page is `fixtures/notification-open-scene.ts`:
 * the shell's own tap wiring — the entry point's inbox, the real route table, `openNotificationTap` — over a router that
 * only writes the address it was sent to. Every page load is answered by the verified release, so `/d/<id>/…` reaches the
 * app through the real `_redirects`.
 *
 * A PUSH is delivered to one machine's registration over DevTools (`ServiceWorker.deliverPushMessage`). A TAP is a
 * `notificationclick` dispatched in that worker on the notification it actually showed. Chromium grants a worker the right
 * to focus a window or open one only inside a tap the READER made, which nothing a test can send is, so in the worker's
 * realm — and only there — `WindowClient.focus` and `Clients.openWindow` are replaced with recorders that answer as a
 * granted call would. Everything else is the browser's own: which windows `Clients.matchAll` finds, the message to the page,
 * the page's reply and `WindowClient.navigate`, which a machine's worker is refused because it controls no page. A window the
 * worker opens is opened by the suite at exactly the URL the worker asked for, which is what the browser would have done.
 *
 * Proved, for a push from machine Beta while Alpha is also paired:
 *   - the app closed: the worker opens Beta's chat at the ask;
 *   - the app open on Alpha's chat: that window is routed in the app — no second window, no reload — and the plugins of
 *     Beta (and only Beta) are told, with the tag;
 *   - a push that names no page the shell accepts still opens the conversation it is about, or that machine's home;
 *   - a window still starting when the tap lands is routed once it is up, without a second window;
 *   - a window that never answers (an app too old for the message) still ends on the page, in a window of the worker's own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page, Worker } from 'playwright-core';
import { releaseKey, run, sharedChromium, signedRelease, waitFor } from '../support/browser/index.ts';

const packageRoot = resolve(import.meta.dir, '../..');
const LANDING = '<!doctype html><meta charset="utf-8"><title>landing</title><p>landing</p>';
const APP = `<!doctype html><meta charset="utf-8"><title>app</title>
<div id="route"></div><script type="module" src="/app/scene.js"></script>`;

/** The two paired machines: the scope each one's push worker takes, and the label its worker is titled with. */
const MACHINES = {
  alpha: { scope: '/push/alpha/', script: '/sw.verified.js?machine=Alpha' },
  beta: { scope: '/push/beta/', script: '/sw.verified.js?machine=Beta' },
} as const;
type MachineName = keyof typeof MACHINES;

/** The push an ask raises: the machine-relative page of the ferret's chat, at the ask. */
const ASK = {
  title: '“Builder”: Pick a release window',
  body: 'b',
  url: '/ferrets/mvb9x0-c0ffee01/chat?ask=A3',
  tag: 'agenda-mvb9x0-c0ffee01:A3',
  kind: 'agenda',
} as const;
const BETA_ASK = '/d/beta/ferrets/mvb9x0-c0ffee01/chat?ask=A3';
const ALPHA_CHAT = '/d/alpha/ferrets/mva1-aaaa0001/chat';

let workDirectory = '';
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let site = new Map<string, Uint8Array>();
const origin = (): string => `http://127.0.0.1:${server.port}`;
const pause = (milliseconds: number) => new Promise(done => setTimeout(done, milliseconds));

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'ferretry-notification-open-'));
  const scene = join(workDirectory, 'scene.js');
  run([
    'bun',
    'build',
    resolve(packageRoot, 'tests/integration/fixtures/notification-open-scene.ts'),
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

interface Profile {
  readonly context: BrowserContext;
  readonly setup: Page;
  readonly cdp: CDPSession;
  readonly seen: Map<string, string>;
}

/** One browser profile with the app's worker installed at `/` and each machine's push worker at its own scope. */
const profile = async (): Promise<Profile> => {
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
    // The installed page enforces Trusted Types (`public/_headers`), so a registration takes only what the app's
    // `fy-worker` policy made (`src/security/trusted-types.ts`).
    const policy = (
      globalThis as unknown as {
        trustedTypes: { createPolicy(name: string, rules: object): { createScriptURL(url: string): string } };
      }
    ).trustedTypes.createPolicy('fy-worker', { createScriptURL: (url: string) => url });
    for (const { script, scope } of machines) {
      const registration = await navigator.serviceWorker.register(policy.createScriptURL(script), { scope });
      const worker = registration.installing ?? registration.waiting ?? registration.active;
      if (worker === null || worker.state === 'activated') continue;
      await new Promise<void>(active => {
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated') active();
        });
      });
    }
  }, Object.values(MACHINES));
  return { context, setup, cdp, seen };
};

/** Takes the setup tab out of the picture — a blank page is no window of this site — keeping its DevTools session. */
const retire = async (browserProfile: Profile): Promise<void> => {
  await browserProfile.setup.goto('about:blank');
};

/** The worker serving `script`, started if the browser had stopped it. */
const workerFor = async (browserProfile: Profile, machine: MachineName): Promise<Worker> => {
  const { scope, script } = MACHINES[machine];
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const found = browserProfile.context.serviceWorkers().find(worker => worker.url() === `${origin()}${script}`);
    if (found !== undefined) return found;
    await browserProfile.cdp
      .send('ServiceWorker.startWorker', { scopeURL: `${origin()}${scope}` })
      .catch(() => undefined);
    await pause(100);
  }
  throw new Error(`no running worker for ${script}`);
};

const shownBy = async (browserProfile: Profile, machine: MachineName): Promise<number> =>
  await (await workerFor(browserProfile, machine)).evaluate(
    async () =>
      (
        await (
          globalThis as unknown as { registration: { getNotifications(): Promise<unknown[]> } }
        ).registration.getNotifications()
      ).length,
  );

/**
 * Delivers one push to one machine's registration and waits until its notification is on screen. A DevTools delivery is
 * occasionally dropped, so an unseen push is sent again under the same tag, which replaces rather than adds.
 */
const push = async (browserProfile: Profile, machine: MachineName, payload: Record<string, unknown>): Promise<void> => {
  const scope = `${origin()}${MACHINES[machine].scope}`;
  const send = async () =>
    await browserProfile.cdp.send('ServiceWorker.deliverPushMessage', {
      origin: origin(),
      registrationId: await waitFor(
        () => browserProfile.seen.get(scope),
        `DevTools to report the registration at ${scope}`,
        {
          pollMs: 50,
        },
      ),
      data: JSON.stringify(payload),
    });
  await send();
  const deadline = Date.now() + 60_000;
  let resendAt = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if ((await shownBy(browserProfile, machine)) > 0) return;
    if (Date.now() >= resendAt) {
      resendAt = Date.now() + 3_000;
      await send();
    }
    await pause(50);
  }
  throw new Error(`the push to ${machine} was never shown`);
};

/** What the worker did with the tap: the windows it brought forward, and the ones it opened. */
interface Tap {
  readonly focused: readonly string[];
  readonly opened: readonly string[];
}

/** Taps the notification a machine's worker shows. See the file's comment for the two recorders. Answers a wait for the handler. */
const tap = async (browserProfile: Profile, machine: MachineName): Promise<() => Promise<Tap>> => {
  const worker = await workerFor(browserProfile, machine);
  await worker.evaluate(async () => {
    type Record = { focused: string[]; opened: string[]; pending: Promise<unknown>[] };
    const realm = globalThis as unknown as {
      __tap?: Record;
      registration: { getNotifications(): Promise<Notification[]> };
      dispatchEvent(event: Event): boolean;
      Clients: { prototype: { openWindow(url: string): Promise<unknown> } };
      WindowClient: { prototype: { focus(): Promise<unknown>; readonly url: string } };
      NotificationEvent: new (type: string, init: { notification: Notification }) => Event;
    };
    if (realm.__tap === undefined) {
      const record: Record = { focused: [], opened: [], pending: [] };
      realm.__tap = record;
      realm.Clients.prototype.openWindow = async (url: string) => {
        record.opened.push(url);
        return null;
      };
      realm.WindowClient.prototype.focus = async function (this: { url: string }) {
        record.focused.push(this.url);
        return this;
      };
    }
    const [notification] = await realm.registration.getNotifications();
    if (notification === undefined) throw new Error('nothing to tap');
    const click = new realm.NotificationEvent('notificationclick', { notification }) as Event & {
      waitUntil(work: Promise<unknown>): void;
    };
    const record = realm.__tap;
    // The handler hands its whole job, the reply wait and the fallback included, to waitUntil: keeping that promise lets the
    // test wait for the handler to be DONE instead of guessing how long it takes.
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

/** What the scene shows: where the window is, and the address the app was routed to. */
interface Shown {
  readonly path: string;
  readonly route: { readonly path: string; readonly daemon: string | null } | null;
  readonly heard: readonly { daemon: string; url: string; tag?: string }[];
}

const shown = async (page: Page): Promise<Shown> =>
  await page.evaluate(() => {
    const raw = document.querySelector<HTMLElement>('#route')?.dataset.route;
    return {
      path: `${location.pathname}${location.search}`,
      route: raw === undefined ? null : JSON.parse(raw),
      heard: (globalThis as unknown as { __heard?: [] }).__heard ?? [],
    };
  });

/** Waits until the window shows `path` with the app routed there, or answers what it shows instead. */
const settledOn = async (page: Page, path: string, timeout = 60_000): Promise<Shown> => {
  const deadline = Date.now() + timeout;
  let last = await shown(page).catch(() => null);
  while (Date.now() < deadline) {
    if (last?.path === path && last.route?.path === path) return last;
    await pause(50);
    last = await shown(page).catch(() => null);
  }
  return last ?? { path: 'unreadable', route: null, heard: [] };
};

/** Opens the app at `path` in a window of its own, the way the reader left it. */
const appAt = async (browserProfile: Profile, path: string, options: { held?: boolean; wired?: boolean } = {}) => {
  const page = await browserProfile.context.newPage();
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

/** Runs a case in a fresh profile and closes it however the case ends. */
const inProfile = async (body: (browserProfile: Profile) => Promise<void>): Promise<void> => {
  const browserProfile = await profile();
  try {
    await body(browserProfile);
  } finally {
    await browserProfile.context.close();
  }
};

describe('a notification tap opens its page on the machine that sent it', () => {
  test('with the app closed, the worker opens Beta’s chat at the ask, and the app starts there', async () => {
    await inProfile(async browserProfile => {
      await push(browserProfile, 'beta', ASK);
      await retire(browserProfile);
      const { opened, focused } = await (await tap(browserProfile, 'beta'))();
      expect(focused).toEqual([]);
      expect(opened).toEqual([`${origin()}${BETA_ASK}`]);

      const window = await browserProfile.context.newPage();
      await window.goto(opened[0] ?? '');
      const landed = await settledOn(window, BETA_ASK);
      expect(landed.route).toEqual({ path: BETA_ASK, daemon: 'beta' });
    });
  }, 120_000);

  test('with the app on Alpha’s chat, routes that window to Beta’s — no second window, no reload — and tells Beta’s plugins', async () => {
    await inProfile(async browserProfile => {
      const app = await appAt(browserProfile, ALPHA_CHAT);
      await retire(browserProfile);
      await app.evaluate(() => {
        (globalThis as unknown as { __sameDocument: boolean }).__sameDocument = true;
      });
      await push(browserProfile, 'beta', ASK);

      const tapped = await tap(browserProfile, 'beta');
      const landed = await settledOn(app, BETA_ASK);
      const done = await tapped();

      expect(landed.route).toEqual({ path: BETA_ASK, daemon: 'beta' });
      expect(landed.heard).toEqual([{ daemon: 'beta', url: BETA_ASK, tag: ASK.tag }]);
      expect(done.opened).toEqual([]);
      expect(done.focused).toEqual([`${origin()}${ALPHA_CHAT}`]);
      expect(await app.evaluate(() => (globalThis as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(
        true,
      );
      expect(browserProfile.context.pages().filter(page => page.url().startsWith(origin()))).toHaveLength(1);
    });
  }, 120_000);

  test('a push that names no accepted page opens the conversation it is about, or that machine’s home', async () => {
    const unnamed = [
      { payload: { ...ASK, url: '/', sessionId: 'mvb9x0-c0ffee01' }, expected: '/d/beta/ferrets/mvb9x0-c0ffee01/chat' },
      { payload: { ...ASK, url: '/no/such/page' }, expected: '/d/beta' },
    ] as const;
    for (const { payload, expected } of unnamed)
      await inProfile(async browserProfile => {
        const app = await appAt(browserProfile, ALPHA_CHAT);
        await retire(browserProfile);
        await push(browserProfile, 'beta', payload);
        await tap(browserProfile, 'beta');
        const landed = await settledOn(app, expected);
        expect(landed.route).toEqual({ path: expected, daemon: 'beta' });
      });
  }, 180_000);

  test('a window still starting when the tap lands is routed once the app is up, without a second window', async () => {
    await inProfile(async browserProfile => {
      // The store is still loading — the router is not mounted — for as long as the test holds it.
      const app = await appAt(browserProfile, ALPHA_CHAT, { held: true });
      await retire(browserProfile);
      await push(browserProfile, 'beta', ASK);

      const tapped = await tap(browserProfile, 'beta');
      // The worker is done — the entry point's inbox answered it, no second window — with nothing mounted yet.
      expect((await tapped()).opened).toEqual([]);
      expect((await shown(app)).route).toBeNull();
      await app.evaluate(() => (globalThis as unknown as { __mountScene: () => void }).__mountScene());
      const landed = await settledOn(app, BETA_ASK);

      expect(landed.route).toEqual({ path: BETA_ASK, daemon: 'beta' });
    });
  }, 120_000);

  test('a window that never answers (an app too old for the message) still ends on the page, in a window of the worker’s own', async () => {
    await inProfile(async browserProfile => {
      const stale = await appAt(browserProfile, ALPHA_CHAT, { wired: false });
      await retire(browserProfile);
      await push(browserProfile, 'beta', ASK);

      const tapped = await tap(browserProfile, 'beta');
      const done = await tapped();

      // A machine's worker controls no page, so it may not navigate that window: it opens the page in one of its own.
      expect(await stale.evaluate(() => location.pathname)).toBe(ALPHA_CHAT);
      expect(done.opened).toEqual([`${origin()}${BETA_ASK}`]);
    });
  }, 120_000);

  test('each machine’s notification opens only its own machine’s page', async () => {
    await inProfile(async browserProfile => {
      const app = await appAt(browserProfile, '/d/beta');
      await retire(browserProfile);
      // Alpha's push names Beta's page outright: its worker keeps to its own machine and lands on Alpha's home.
      await push(browserProfile, 'alpha', { ...ASK, url: BETA_ASK });
      await tap(browserProfile, 'alpha');
      const landed = await settledOn(app, '/d/alpha');

      expect(landed.route).toEqual({ path: '/d/alpha', daemon: 'alpha' });
    });
  }, 120_000);
});
