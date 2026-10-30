/**
 * The `html` frame's isolation claims, measured in real Chromium.
 *
 * THIS SHELL RUNS AUTHOR CODE, so the attacker position here is not something a
 * test has to splice in — it is the product. Every probe below is an ordinary
 * `<script>` in an agent-authored page, delivered to the REAL generated shell
 * (`fy-render-html.html`, built fresh in a child process by the same loader the
 * library-sandbox file uses) over the real handshake. Nothing in the shell or its
 * policy is relaxed.
 *
 * EVIDENCE IS TWO THINGS AT ONCE, as in `fy-render-sandbox.security.test.ts`: the
 * page reports what it observed, and a server-side ledger records every request
 * the harness received. A refusal the page reports and the ledger contradicts is
 * not a refusal — an opaque origin makes every response opaque, so a `fetch` reads
 * as refused whether or not its request left.
 *
 * The page cannot reach the port (the bootstrap holds it in a closure), so it
 * reports with `parent.postMessage` — the one channel any cross-origin frame has.
 * The product parent ignores such messages after its handshake; this harness
 * parent collects them.
 *
 * WHAT IS PROVEN TO STILL LEAK is proven too: a page that navigates its own frame
 * does make that request, and the parent does see a second `load` — which is the
 * signal `FyRenderHtmlFrame` tears the frame down on. That residual is
 * `docs/fy-render.md` gap 1, measured rather than asserted.
 *
 * CHROMIUM ONLY, a stated limit shared with the sibling file.
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import type { Browser, Page } from 'playwright-core';
import should from 'should';
import { sharedChromium } from './support/chromium.ts';
import { fyRenderIntegrationFixture } from './support/fy-render-integration-fixture.ts';

interface LedgerHit {
  readonly path: string;
  readonly site: string | null;
  readonly origin: string | null;
}

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let htmlShell: string;
const ledger: LedgerHit[] = [];

/** A stand-in for a credential the app holds; it must appear nowhere inside the frame. */
const DAEMON_TOKEN = 'fy-daemon-token-7f3c9a';

/** Requests the opaque frame is responsible for: every one of them is cross-site to this server. */
const frameHits = (): readonly LedgerHit[] =>
  ledger.filter(hit => hit.path.startsWith('/beacon') && (hit.site === 'cross-site' || hit.origin === 'null'));

interface Drive {
  readonly reports: readonly Record<string, string>[];
  readonly replies: readonly { readonly kind?: string; readonly height?: number }[];
  readonly loads: number;
}

/**
 * WHEN A DRIVE ENDS. A fixed idle wait made every probe cost its whole budget even though the page
 * says when it is done. A drive now ends `quietMs` after the event that means "the page has had
 * its say": `report` (the probe page posted its report — its own in-page window already let every
 * request it provoked leave), `rendered` (the shell confirmed the page, for authored markup that
 * has no script to report), or `second-load` (the frame navigated itself). The quiet window is
 * what remains of the negative proofs: a request the frame made would reach the ledger within it.
 * `capMs` still bounds a page that never says anything, so a silent failure resolves rather than hangs.
 */
interface DriveOptions {
  readonly capMs?: number;
  readonly paint?: unknown;
  readonly quietMs?: number;
  readonly until?: 'report' | 'rendered' | 'second-load';
}

/**
 * Mounts the real shell exactly as `FyRenderHtmlFrame` does — `sandbox="allow-scripts"`,
 * listener before `src`, identity-checked handshake, the page sent as data over the
 * port — and returns what the parent observed once the drive ends (see `DriveOptions`).
 */
const drive = (source: string, options: DriveOptions = {}): string => `(async () => {
  return await new Promise(resolve => {
    const reports = [];
    const replies = [];
    let loads = 0;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.style.cssText = 'width:600px;height:400px;border:0';
    let port = null;
    let ending = null;
    const endSoon = (trigger, quiet) => {
      if (trigger !== ${JSON.stringify(options.until ?? 'report')} || ending !== null) return;
      ending = setTimeout(() => resolve({ reports, replies, loads }), quiet);
    };
    addEventListener('message', event => {
      if (event.source !== frame.contentWindow) return;
      if (event.data && event.data.kind === 'probe-report') { reports.push(event.data.report); endSoon('report', ${options.quietMs ?? 250}); return; }
      if (port !== null || !event.data || event.data.kind !== 'shell-ready') return;
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = e => { replies.push(e.data); if (e.data && e.data.kind === 'rendered') endSoon('rendered', ${options.quietMs ?? 250}); };
      frame.contentWindow.postMessage({ kind: 'init' }, '*', [channel.port2]);
      port.postMessage({ kind: 'render-html', paint: ${JSON.stringify(options.paint ?? null)}, source: ${JSON.stringify(source)}, theme: 'dark' });
    });
    document.body.appendChild(frame);
    // AFTER insertion, as FyRenderHtmlFrame does: inserting a src-less iframe fires a
    // synchronous 'load' for its initial about:blank, which is not a navigation.
    frame.addEventListener('load', () => { loads += 1; if (loads === 2) endSoon('second-load', ${options.quietMs ?? 250}); });
    frame.src = '/fy-render-html.html';
    window.__replies = replies;
    setTimeout(() => resolve({ reports, replies, loads }), ${options.capMs ?? 5_000});
  });
})()`;

/** A page whose one script runs `body`, awaits `pending`, and reports `report` to the parent. */
const probePage = (body: string): string => `<!doctype html>
<html><head><style>body { margin: 0 }</style></head>
<body>
<p id="status">probing</p>
<script>
(async () => {
  const report = {};
  const pending = [];
  const note = (key, fn) => { try { report[key] = String(fn()); } catch (e) { report[key] = 'THREW: ' + (e && e.name); } };
  const settle = (key, promise) => pending.push(promise.then(
    value => { report[key] = 'RESOLVED: ' + value; },
    error => { report[key] = 'REFUSED: ' + (error && error.name); },
  ));
  ${body}
  await Promise.all(pending);
  await new Promise(done => setTimeout(done, 400));
  parent.postMessage({ kind: 'probe-report', report }, '*');
})();
</script>
</body></html>`;

const newPage = async (): Promise<Page> => {
  const page = await browser.newPage();
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === server.url.origin) return await route.continue();
    return await route.abort();
  });
  await page.goto(`${server.url.origin}/parent`);
  // The app's own state, which a same-origin frame could read: storage, a global, and a token.
  await page.evaluate(token => {
    localStorage.setItem('fy-daemon-token', token);
    sessionStorage.setItem('fy-daemon-token', token);
    (window as unknown as { __daemonToken: string }).__daemonToken = token;
  }, DAEMON_TOKEN);
  return page;
};

beforeAll(async () => {
  browser = await sharedChromium();
  htmlShell = (await fyRenderIntegrationFixture()).html;
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, self) {
      const url = new URL(request.url);
      ledger.push({
        origin: request.headers.get('origin'),
        path: url.pathname + url.search,
        site: request.headers.get('sec-fetch-site'),
      });
      if (url.pathname === '/beacon-ws' && self.upgrade(request, { data: undefined }))
        return undefined as unknown as Response;
      if (url.pathname === '/fy-render-html.html')
        return new Response(htmlShell, {
          headers: {
            // What Cloudflare Pages sends for this path (`public/_headers`).
            'content-security-policy': "frame-ancestors 'self'; sandbox allow-scripts",
            'content-type': 'text/html; charset=utf-8',
          },
        });
      if (url.pathname.startsWith('/beacon'))
        return new Response('<!doctype html><title>beacon</title>beaconed', {
          headers: { 'access-control-allow-origin': '*', 'content-type': 'text/html' },
        });
      return new Response('<!doctype html><html lang="en"><body>parent</body></html>', {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': `fy_session=${DAEMON_TOKEN}; Path=/`,
        },
      });
    },
    websocket: { message() {}, open() {} },
  });
});

afterAll(async () => {
  await server?.stop(true);
});

describe('fy-render html — the page runs, interactively', () => {
  test('should run author scripts, report its height, and keep running after a click', async () => {
    ledger.length = 0;
    const page = await newPage();
    try {
      const result = (await page.evaluate(
        drive(
          probePage(`
            const button = document.createElement('button');
            button.id = 'go';
            button.textContent = 'Count';
            let clicks = 0;
            button.onclick = () => { clicks += 1; button.textContent = 'Clicked ' + clicks; };
            document.body.appendChild(button);
            note('ran', () => 'yes');
            note('colorScheme', () => document.documentElement.style.colorScheme);
          `),
        ),
      )) as Drive;

      should(result.reports.length).equal(1);
      should(result.reports[0]?.ran).equal('yes');
      // The reader's mode reached the page as its default.
      should(result.reports[0]?.colorScheme).equal('dark');
      should(result.replies.some(reply => reply.kind === 'rendered')).be.true();
      should(result.replies.some(reply => reply.kind === 'height' && (reply.height ?? 0) >= 1)).be.true();
      // Moving author content in by script fires no second `load`.
      should(result.loads).equal(1);

      // A real click, through the real frame.
      await page.frameLocator('iframe').locator('#go').click();
      should(await page.frameLocator('iframe').locator('#go').textContent()).equal('Clicked 1');
      should(frameHits().length).equal(0);
    } finally {
      await page.close();
    }
  });

  test('should forward Escape pressed inside the frame to the parent', async () => {
    const page = await newPage();
    try {
      await page.evaluate(drive(probePage(`note('ready', () => 'yes');`)));
      await page.frameLocator('iframe').locator('#status').click();
      await page.keyboard.press('Escape');
      // The forward is a message round trip, so wait for it rather than for a fixed time; a missing
      // forward fails here on the timeout instead of passing on a lucky read.
      await page.waitForFunction(() =>
        (window as unknown as { __replies: { kind?: string }[] }).__replies.some(reply => reply.kind === 'escape'),
      );
    } finally {
      await page.close();
    }
  });
});

describe('fy-render html — the opaque origin reaches nothing of the app', () => {
  test('should deny storage, cookies, the parent document and every trace of the token', async () => {
    ledger.length = 0;
    const page = await newPage();
    try {
      const result = (await page.evaluate(
        drive(
          probePage(`
            note('localStorage', () => localStorage.getItem('fy-daemon-token'));
            note('sessionStorage', () => sessionStorage.getItem('fy-daemon-token'));
            note('cookie', () => 'cookie=[' + document.cookie + ']');
            note('parentDocument', () => parent.document.body.textContent);
            note('parentToken', () => parent.__daemonToken);
            note('parentStorage', () => parent.localStorage.getItem('fy-daemon-token'));
            note('topLocation', () => top.location.href);
            note('origin', () => origin);
            settle('indexedDB', new Promise((res, rej) => {
              try {
                const request = indexedDB.open('steal');
                request.onsuccess = () => res('OPENED');
                request.onerror = () => rej(new DOMException('onerror', 'NotAllowed'));
                setTimeout(() => rej(new DOMException('never opened', 'TimeoutError')), 1000);
              } catch (error) { rej(error); }
            }));
            note('everything', () => [document.documentElement.outerHTML, location.href, name, document.referrer].join('|'));
          `),
        ),
      )) as Drive;

      const report = result.reports[0] ?? {};
      should(result.reports.length).equal(1);
      // No partition yields the app's state, and nothing the frame can see carries the token.
      for (const key of ['localStorage', 'sessionStorage', 'cookie', 'parentDocument', 'parentToken', 'parentStorage'])
        should(report[key] ?? '').not.containEql(DAEMON_TOKEN);
      should(report.parentDocument ?? '').not.containEql('parent');
      should(report.topLocation ?? '').not.containEql('http');
      should(report.origin).equal('null');
      should(report.indexedDB ?? '').not.containEql('OPENED');
      should(report.everything ?? '').not.containEql(DAEMON_TOKEN);
    } finally {
      await page.close();
    }
  });
});

describe('fy-render html — the page cannot leave its box', () => {
  test('should refuse top navigation, popups and an opener, and never cover the app around it', async () => {
    ledger.length = 0;
    const page = await newPage();
    try {
      const base = server.url.origin;
      // A sentinel in the APP, beside the frame, that a page escaping its box would cover.
      await page.evaluate(
        `(() => { const s = document.createElement('div'); s.id = 'sentinel'; s.style.cssText = 'position:fixed;left:700px;top:20px;width:80px;height:80px'; document.body.appendChild(s); })()`,
      );
      const result = (await page.evaluate(
        drive(
          probePage(`
            note('topNavigation', () => { top.location.href = '${base}/beacon?top'; return 'assigned'; });
            note('popup', () => String(window.open('${base}/beacon?popup')));
            note('opener', () => String(window.opener));
            const cover = document.createElement('div');
            cover.style.cssText = 'position:fixed;inset:-5000px;z-index:2147483647;background:red';
            document.body.appendChild(cover);
            note('covered', () => 'drawn');
          `),
        ),
      )) as Drive;
      const outside = await page.evaluate<{ hit: string; url: string }>(`({
        hit: document.elementFromPoint(740, 60)?.id ?? 'none',
        url: location.pathname,
      })`);

      const report = result.reports[0] ?? {};
      should(result.reports.length).equal(1);
      // `allow-top-navigation` is not granted, so assigning top's location throws.
      should(report.topNavigation ?? '').match(/^THREW/u);
      should(report.popup).equal('null');
      should(report.opener).equal('null');
      // The app's page never moved, and its own element is still what sits beside the frame.
      should(outside).eql({ hit: 'sentinel', url: '/parent' });
      should(ledger.some(hit => hit.path === '/beacon?top' || hit.path === '/beacon?popup')).be.false();
      should(result.loads).equal(1);
    } finally {
      await page.close();
    }
  });
});

describe('fy-render html — ordinary requests are refused', () => {
  test('should refuse fetch, XHR, WebSocket, EventSource, beacons, images, workers, frames and forms', async () => {
    ledger.length = 0;
    const page = await newPage();
    try {
      const base = server.url.origin;
      const result = (await page.evaluate(
        drive(
          probePage(`
            settle('fetch', fetch('${base}/beacon?fetch').then(r => r.status));
            settle('xhr', new Promise((res, rej) => {
              const xhr = new XMLHttpRequest();
              xhr.onload = () => res(xhr.status);
              xhr.onerror = () => rej(new DOMException('xhr', 'NetworkError'));
              try { xhr.open('GET', '${base}/beacon?xhr'); xhr.send(); } catch (error) { rej(error); }
            }));
            settle('websocket', new Promise((res, rej) => {
              try {
                const socket = new WebSocket('${base.replace('http', 'ws')}/beacon-ws');
                socket.onopen = () => res('OPEN');
                socket.onerror = () => rej(new DOMException('ws', 'NetworkError'));
              } catch (error) { rej(error); }
            }));
            settle('eventsource', new Promise((res, rej) => {
              try {
                const source = new EventSource('${base}/beacon?sse');
                source.onopen = () => res('OPEN');
                source.onerror = () => rej(new DOMException('sse', 'NetworkError'));
              } catch (error) { rej(error); }
            }));
            note('beacon', () => navigator.sendBeacon('${base}/beacon?sendbeacon', 'x'));
            settle('image', new Promise((res, rej) => {
              const image = new Image();
              image.onload = () => res('LOADED');
              image.onerror = () => rej(new DOMException('img', 'NetworkError'));
              image.src = '${base}/beacon?img';
            }));
            note('worker', () => new Worker('${base}/beacon?worker'));
            const nested = document.createElement('iframe');
            nested.src = '${base}/beacon?frame';
            document.body.appendChild(nested);
            const form = document.createElement('form');
            form.action = '${base}/beacon?form';
            form.method = 'POST';
            document.body.appendChild(form);
            note('form', () => { form.submit(); return 'submitted'; });
            note('eval', () => eval('6 * 7'));
            note('popup', () => String(window.open('${base}/beacon?popup')));
            note('rtc', () => typeof RTCPeerConnection);
          `),
        ),
      )) as Drive;

      const report = result.reports[0] ?? {};
      should(result.reports.length).equal(1);
      for (const key of ['fetch', 'xhr', 'websocket', 'eventsource', 'image'])
        should(report[key] ?? '').startWith('REFUSED');
      // `sendBeacon` answers `true` once QUEUED, before policy refuses the send — so its
      // return value proves nothing, and the ledger below is the evidence.
      should(report.eval ?? '').not.equal('42');
      should(report.popup ?? '').equal('null');
      // The easy WebRTC spelling is gone before author code runs — a speed bump, not a boundary.
      should(report.rtc).equal('undefined');
      // And the server agrees: nothing the frame tried arrived.
      should(frameHits()).be.empty();
      should(result.loads).equal(1);
    } finally {
      await page.close();
    }
  });

  test('should strip a meta refresh and a prerender link from the authored markup', async () => {
    ledger.length = 0;
    const page = await newPage();
    try {
      const base = server.url.origin;
      const result = (await page.evaluate(
        drive(
          `<!doctype html><html><head>
            <meta http-equiv="refresh" content="0;url=${base}/beacon?meta">
            <link rel="prerender" href="${base}/beacon?prerender">
            <link rel="prefetch" href="${base}/beacon?prefetch">
            <base href="${base}/beacon/">
            <script type="speculationrules">{"prerender":[{"source":"list","urls":["${base}/beacon?rules"]}]}</script>
          </head><body><p>still here</p></body></html>`,
          { quietMs: 800, until: 'rendered' },
        ),
      )) as Drive;
      should(result.loads).equal(1);
      should(frameHits()).be.empty();
    } finally {
      await page.close();
    }
  });
});

describe('fy-render html — the column paint', () => {
  test('should paint the page with the column’s colours, and fetch nothing for a hostile paint value', async () => {
    ledger.length = 0;
    const page = await newPage();
    try {
      const base = server.url.origin;
      const read = probePage(`
        const root = getComputedStyle(document.documentElement);
        note('background', () => root.backgroundColor);
        note('color', () => root.color);
        note('scheme', () => document.documentElement.style.colorScheme);
        note('margin', () => getComputedStyle(document.body).margin);
      `);
      // The paint `FyRenderBlock` reads from the message column.
      const painted = (await page.evaluate(
        drive(read, { paint: { background: 'rgb(1, 2, 3)', color: 'rgb(4, 5, 6)', font: 'serif', scheme: 'light' } }),
      )) as Drive;
      should(painted.reports[0]?.background).equal('rgb(1, 2, 3)');
      should(painted.reports[0]?.color).equal('rgb(4, 5, 6)');
      should(painted.reports[0]?.scheme).equal('light');
      // Frameless: the page starts flush with the prose around it.
      should(painted.reports[0]?.margin).equal('0px');

      // A paint value that tries to name a URL is not a colour or a font family,
      // so `setProperty` drops it and nothing is requested.
      const hostile = (await page.evaluate(
        drive(read, {
          paint: {
            background: `url(${base}/beacon?paint-background)`,
            color: `red; background-image: url(${base}/beacon?paint-color)`,
            font: `x; background: url(${base}/beacon?paint-font)`,
            scheme: 'dark',
          },
        }),
      )) as Drive;
      should(hostile.reports.length).equal(1);
      should(ledger.some(hit => hit.path.includes('paint-'))).be.false();
    } finally {
      await page.close();
    }
  });
});

describe('fy-render html — the residual the parent detects', () => {
  test('should show a second load when the page navigates its own frame, which DOES egress', async () => {
    ledger.length = 0;
    const page = await newPage();
    try {
      const base = server.url.origin;
      const result = (await page.evaluate(
        drive(`<!doctype html><body><script>location.href = '${base}/beacon?navigate';</script></body>`, {
          until: 'second-load',
        }),
      )) as Drive;
      // The navigation reached the server — the measured residual, not a refusal.
      should(ledger.some(hit => hit.path === '/beacon?navigate')).be.true();
      // And the parent saw it as a second `load`, which `FyRenderHtmlFrame` tears down on.
      should(result.loads).equal(2);
    } finally {
      await page.close();
    }
  });
});
