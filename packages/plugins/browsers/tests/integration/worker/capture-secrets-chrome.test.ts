import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { BrowserWorkerClient } from '../../../daemon/worker/client.ts';
import { REAL_WORKER } from '../../support/process-workers.ts';
import { wallClock } from '../../support/wall-clock.ts';

// Synthetic values only. Both listeners are in the builder port range; no external requests are permitted.
const VALUE = 'synthetic-G27-input-482913';
const ORIGIN = 'http://capture.localhost:7490';
const PASSWORD = 'type="password"';
const ATTRIBUTES = [
  PASSWORD,
  'autocomplete="current-password"',
  'autocomplete="new-password"',
  'autocomplete="one-time-code"',
];
const FIELD = { kind: 'selector', selector: '#secret' } as const;
const SIGNAL = 'fixture echo';
const fixture = (attributes: string, shadow: boolean, closed = false) => {
  const contents = `<style>
input { position:absolute;left:30px;top:40px;width:240px;height:40px;background:white;color:black;font:20px monospace }
#echo { position:absolute;top:120px }
</style>
<input id="secret" ${attributes}><p id="echo">${SIGNAL}</p><button id="download" style="position:absolute;top:200px">Download</button>`;
  return `<!doctype html><title>Capture proof</title><body>
${shadow ? '<div id="host"></div>' : contents}
<script>
const root = ${shadow ? `document.querySelector('#host').attachShadow({mode:'${closed ? 'closed' : 'open'}'})` : 'document'};
${shadow ? `root.innerHTML = ${JSON.stringify(contents)};` : ''}
const field = root.querySelector('#secret');
field.addEventListener('input', event => {
  const value = field.value;
  root.querySelector('#echo').textContent = '${SIGNAL} ' + value;
  document.body.dataset.trusted = String(event.isTrusted);
  document.body.dataset.inserted = value;
  console.log('${SIGNAL} ' + value);
  fetch('/echo?value=' + encodeURIComponent(value), {
    method:'POST', headers:{'x-request-echo':value}, body:value,
  }).then(response => response.text()).then(text => {
    if (text === '${SIGNAL} ' + value) document.body.dataset.sent = 'yes';
  });
});
root.querySelector('#download').onclick = () => {
  const link = document.createElement('a');
  link.download = field.value + '.txt';
  link.href = URL.createObjectURL(new Blob([field.value]));
  link.click();
};
</script></body>`;
};

let root = '';
let context: BrowserContext;
let decodingBrowser: Browser;
let decoder: Page;
let client: BrowserWorkerClient;
let pageId = '';
let fixtureId = 0;
let site: ReturnType<typeof Bun.serve>;
let echo: { readonly header: string | null; readonly body: string } | undefined;

async function opened(attributes = PASSWORD, place = 'main') {
  const url = `${ORIGIN}/?attributes=${encodeURIComponent(attributes)}&place=${place}&case=${++fixtureId}`;
  pageId = (await client.newPage({ url })).actedPageId;
  const raw = context.pages().find(page => page.url() === url);
  if (!raw) throw new Error('Chromium did not expose the fixture page');
  await raw.bringToFront();
  const document = place === 'iframe' || place === 'cross' ? raw.frameLocator('iframe') : raw;
  return { raw, field: document.locator('#secret'), reflected: document.locator('#echo') };
}

async function expectInserted(field: Locator, reflected: Locator, value = VALUE): Promise<void> {
  expect(await field.inputValue()).toBe(value);
  expect(await reflected.innerText()).toBe(`${SIGNAL} ${value}`);
  expect(await field.evaluate(node => node.ownerDocument.body.dataset.trusted)).toBe('true');
}

async function fill(attributes = PASSWORD, place = 'main', value = VALUE) {
  const fixturePage = await opened(attributes, place);
  await fixturePage.field.fill(value);
  await expectInserted(fixturePage.field, fixturePage.reflected, value);
  return fixturePage;
}

async function blackAt(base64: string, format = 'png', x = 250, y = 75, expectClear = true): Promise<void> {
  const [covered, clear] = await decoder.evaluate(
    async ({ base64, format, x, y }) => {
      const image = new Image();
      image.src = `data:image/${format};base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Chromium did not provide a canvas decoder');
      ctx.drawImage(image, 0, 0);
      if (x >= image.width || y >= image.height) throw new Error('fixture field lies outside the captured image');
      return [
        [...ctx.getImageData(x, y, 1, 1).data],
        [...ctx.getImageData(image.width - 5, image.height - 5, 1, 1).data],
      ];
    },
    { base64, format, x, y },
  );
  if (expectClear) expect(clear.slice(0, 3).every(channel => channel > 235)).toBe(true);
  expect(covered.slice(0, 3).every(channel => channel < 20)).toBe(true);
}

async function noMagenta(base64: string, format = 'png'): Promise<void> {
  const exposed = await decoder.evaluate(
    async ({ base64, format }) => {
      const image = new Image();
      image.src = `data:image/${format};base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('decoder unavailable');
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let at = 0; at < pixels.length; at += 4)
        if ((pixels[at] ?? 0) > 220 && (pixels[at + 1] ?? 255) < 30 && (pixels[at + 2] ?? 0) > 220) count += 1;
      return count;
    },
    { base64, format },
  );
  expect(exposed).toBe(0);
}

describe('G27: real worker capture paths never expose filled fields', () => {
  beforeAll(async () => {
    const executablePath = Bun.which('google-chrome') ?? Bun.which('chromium');
    if (!executablePath) throw new Error('this proof needs a real Chromium on PATH');
    root = await mkdtemp(join(tmpdir(), 'g27-chrome-'));
    site = Bun.serve({
      hostname: '127.0.0.1',
      port: 7490,
      fetch: async request => {
        const url = new URL(request.url);
        if (url.pathname === '/echo') {
          const body = await request.text();
          echo = { header: request.headers.get('x-request-echo'), body };
          return new Response(`${SIGNAL} ${body}`, {
            headers: { 'content-type': 'text/plain', 'x-response-echo': body },
          });
        }
        if (url.pathname === '/large')
          return new Response('x'.repeat(65_520) + VALUE, { headers: { 'content-type': 'text/plain' } });
        const attributes = url.searchParams.get('attributes') ?? PASSWORD;
        const place = url.searchParams.get('place');
        const html =
          place === 'iframe' || place === 'cross'
            ? `<!doctype html><iframe src="${place === 'cross' ? 'http://child.localhost:7490' : ''}/child?attributes=${encodeURIComponent(attributes)}" style="position:absolute;left:0;top:0;width:600px;height:400px;border:0"></iframe>`
            : fixture(attributes, place === 'shadow' || place === 'closed', place === 'closed');
        const preset = url.searchParams.get('preset');
        return new Response(
          html +
            (preset
              ? `<script>(()=>{document.querySelector('#secret').value=${JSON.stringify(preset)};document.title=${JSON.stringify(preset)};})()</script>`
              : ''),
          { headers: { 'content-type': 'text/html' } },
        );
      },
    });
    const privateArgs = ['--no-sandbox', '--no-proxy-server', '--disable-background-networking'];
    context = await chromium.launchPersistentContext(join(root, 'profile'), {
      executablePath,
      headless: true,
      viewport: null,
      args: [
        ...privateArgs,
        '--remote-debugging-port=7491',
        '--host-resolver-rules=MAP *.localhost 127.0.0.1, MAP * ~NOTFOUND',
      ],
    });
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname.endsWith('.localhost') && url.port === '7490') await route.continue();
      else await route.abort();
    });
    // A test-owned decoder, outside the worker's browser, sees only the returned picture.
    decodingBrowser = await chromium.launch({
      executablePath,
      headless: true,
      args: [...privateArgs, '--host-resolver-rules=MAP * ~NOTFOUND'],
    });
    decoder = await decodingBrowser.newPage();
    const hasFonts = await decoder.evaluate(() => {
      const drawing = document.createElement('canvas').getContext('2d');
      if (!drawing) return false;
      drawing.font = '20px monospace';
      return drawing.measureText('Chromium fixture').width > 0;
    });
    if (!hasFonts)
      throw new Error('Chromium has no usable fonts; set FONTCONFIG_FILE to a config with installed fonts');
    client = await BrowserWorkerClient.connect({
      start: REAL_WORKER().start,
      clock: wallClock(),
      endpoint: 'http://127.0.0.1:7491',
      stageDirectory: join(root, 'stage'),
      environment: { HOME: process.env.HOME, PATH: process.env.PATH },
      frameIntervalMs: 0,
    });
  }, 60_000);

  afterEach(async () => {
    if (pageId) await client.closePage(pageId);
    pageId = '';
    echo = undefined;
  });
  afterAll(async () => {
    await client?.close();
    await context?.close();
    await decodingBrowser?.close();
    site?.stop(true);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('download metadata: discovers a native secret before filename sanitization', async () => {
    const { raw } = await opened();
    const value = 'synthetic-filename-G27-' + 'Z'.repeat(300);
    await raw.evaluate(value => {
      const button = document.querySelector<HTMLButtonElement>('#download');
      if (!button) throw new Error('fixture button missing');
      button.onclick = () => {
        const field = document.createElement('input');
        field.type = 'password';
        field.value = value;
        document.body.append(field);
        const link = document.createElement('a');
        link.download = value + '.txt';
        link.href = URL.createObjectURL(new Blob([value]));
        link.click();
      };
    }, value);
    const downloaded = raw.waitForEvent('download');
    const reply = await client.click(pageId, { kind: 'selector', selector: '#download' });
    expect((await downloaded).suggestedFilename()).toContain(value.slice(0, 12));
    expect(await raw.locator('input').last().inputValue()).toBe(value);
    const notice = reply.downloads?.[0];
    if (!notice) throw new Error('native download was not reported');
    expect(notice.name).not.toContain(value.slice(0, 12));
    expect(notice.state).toBe('failed');
  });

  it('initial metadata: discovers a native value before title/URL limits', async () => {
    const value = 'initial-native-G27-' + 'Z'.repeat(600);
    const url = `${ORIGIN}/?preset=${encodeURIComponent(value)}`;
    const reply = await client.newPage({ url });
    pageId = reply.actedPageId;
    const raw = context.pages().find(page => page.url() === url);
    if (!raw) throw new Error('fixture missing');
    expect(await raw.locator('#secret').inputValue()).toBe(value);
    expect(JSON.stringify(reply)).not.toContain(value.slice(0, 12));
  });

  for (const attributes of ATTRIBUTES) {
    for (const mode of ['text', 'snapshot', 'a11y'] as const) {
      it(`${mode}: masks ${attributes}, including text echoed outside the field`, async () => {
        await fill(attributes);
        const reply = await client.read(pageId, { mode });
        expect(reply.text).toContain(SIGNAL);
        expect(reply.text).not.toContain(VALUE);
      });
    }
  }

  it('eval: scrubs DOM values and outerHTML, and keeps the value masked after type and autocomplete change', async () => {
    const { field } = await fill();
    const reply = await client.evaluate(pageId, {
      source: `() => { const f=document.querySelector('#secret'); f.type='text'; f.autocomplete='off'; return [f.value,document.documentElement.outerHTML]; }`,
    });
    expect(await field.inputValue()).toBe(VALUE);
    expect(await field.getAttribute('type')).toBe('text');
    expect(reply.text).toContain(SIGNAL);
    expect(reply.text).not.toContain(VALUE);
    expect(
      (await client.evaluate(pageId, { source: '() => document.querySelector("#secret").value' })).text,
    ).not.toContain(VALUE);
  });

  it('console: masks a value that the page logged before clearing its field', async () => {
    const { field } = await fill();
    await field.evaluate(node => {
      (node as HTMLInputElement).value = '';
    });
    expect(await field.inputValue()).toBe('');
    const { lifecycle } = await client.lifecycle(pageId, { op: 'console' });
    expect(lifecycle.text).toContain(SIGNAL);
    expect(lifecycle.text).not.toContain(VALUE);
  });

  for (const action of ['list', 'get'] as const) {
    const source = action === 'list' ? 'a POST URL' : 'a response header and the echoed POST body';
    it(`network ${action}: masks ${source}`, async () => {
      const { raw } = await fill();
      await raw.locator('body[data-sent=yes]').waitFor({ state: 'attached', timeout: 5000 });
      expect(echo).toEqual({ header: VALUE, body: VALUE });
      const { lifecycle: listed } = await client.lifecycle(pageId, { op: 'network', action: 'list', filter: '/echo' });
      expect(listed.text).toMatch(/^r\d+ POST 200 fetch .*\/echo/u);
      if (action === 'list') {
        expect(listed.text).not.toContain(VALUE);
      } else {
        const [id] = listed.text.split(' ');
        if (!id) throw new Error('the fixture request has no network log ID');
        const { lifecycle: result } = await client.lifecycle(pageId, { op: 'network', action: 'get', id });
        expect(result.text).toContain('x-response-echo:');
        expect(result.text).toContain(SIGNAL);
        expect(result.text).not.toContain(VALUE);
      }
    });
  }

  it('location and tabs: mask page titles and URLs', async () => {
    const { raw, field } = await fill();
    await field.evaluate(node => {
      const value = (node as HTMLInputElement).value;
      document.title = value;
      history.replaceState({}, '', `/reflected?value=${encodeURIComponent(value)}`);
    });
    expect(await raw.title()).toBe(VALUE);
    expect(raw.url()).toContain(VALUE);
    const reply = await client.location(pageId);
    expect(reply.url).toContain('/reflected');
    expect(reply.pages.find(page => page.id === pageId)?.url).toContain('/reflected');
    expect(JSON.stringify(reply)).not.toContain(VALUE);
  });

  it('network filters and text waits cannot match a remembered value or its mask', async () => {
    const { raw } = await fill();
    await raw.locator('body[data-sent=yes]').waitFor({ state: 'attached', timeout: 5000 });
    for (const needle of [VALUE, '[redacted]']) {
      expect((await client.lifecycle(pageId, { op: 'network', action: 'list', filter: needle })).lifecycle.text).toBe(
        'no requests recorded',
      );
      for (const kind of ['text', 'textGone'] as const)
        expect(
          (await client.lifecycle(pageId, { op: 'wait', condition: { kind, text: needle }, timeoutMs: 1 })).lifecycle
            .matched,
        ).toBe(false);
    }
  });

  it('screenshot: paints literal DOM text echoes as well as native sensitive fields', async () => {
    const { reflected } = await fill();
    await reflected.evaluate(node => {
      node.style.color = 'magenta';
    });
    await noMagenta((await client.screenshot(pageId)).screenshotBase64);
  });

  for (const place of ['iframe', 'shadow']) {
    it(`eval: masks a filled field in ${place}`, async () => {
      await fill('autocomplete="one-time-code"', place);
      const root =
        place === 'iframe'
          ? 'document.querySelector("iframe").contentDocument'
          : 'document.querySelector("#host").shadowRoot';
      const reply = await client.evaluate(pageId, {
        source: `() => [${root}.querySelector('#secret').value, '${SIGNAL}']`,
      });
      expect(reply.text).toContain(SIGNAL);
      expect(reply.text).not.toContain(VALUE);
    });
  }

  for (const place of ['main', 'iframe', 'shadow']) {
    it(`screenshot: paints sensitive fields black in ${place}`, async () => {
      await fill('autocomplete="one-time-code"', place);
      await blackAt((await client.screenshot(pageId)).screenshotBase64);
    });
  }

  it('screenshot: paints a field after page JS changes its type to text', async () => {
    const { field } = await fill();
    await field.evaluate(node => {
      (node as HTMLInputElement).type = 'text';
    });
    expect(await field.inputValue()).toBe(VALUE);
    await blackAt((await client.screenshot(pageId)).screenshotBase64);
  });

  it('screencast: paints fields before the worker delivers frames', async () => {
    await fill('autocomplete="one-time-code"');
    let receive!: (base64: string) => void;
    const frame = new Promise<string>(resolve => {
      receive = resolve;
    });
    const listener = (value: { dataBase64: string }) => receive(value.dataBase64);
    await client.startScreencast(pageId, { width: 800, height: 600 }, listener);
    try {
      await blackAt(await frame, 'jpeg');
    } finally {
      await client.stopScreencast(pageId, listener);
    }
  });

  it('vault inputType: remembers an arbitrary filled text field before the page can erase it', async () => {
    const { field, reflected } = await opened('type="text"');
    const observed = await client.inputObserve(pageId, [{ id: 'value', target: FIELD }]);
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw new Error('the synthetic field was not observed');
    expect(await client.inputType(pageId, observed.facts, [{ field: 'value', text: VALUE }], false)).toBe('typed');
    await expectInserted(field, reflected);
    await field.evaluate(node => {
      (node as HTMLInputElement).value = '';
    });
    expect(await field.inputValue()).toBe('');
    const reply = await client.read(pageId);
    expect(reply.text).toContain(SIGNAL);
    expect(reply.text).not.toContain(VALUE);
  });

  it('PDF: refuses binary export while a filled secret is on the page', async () => {
    await fill();
    await expect(client.pdf(pageId)).rejects.toThrow(/secret|private|sensitive/iu);
  });

  for (const action of ['notice', 'export'] as const) {
    it(`download ${action}: protects a download made from a filled secret`, async () => {
      const { raw } = await fill();
      const downloaded = raw.waitForEvent('download', { timeout: 5000 });
      const clicked = await client.click(pageId, { kind: 'selector', selector: '#download' });
      expect((await downloaded).suggestedFilename()).toBe(`${VALUE}.txt`);
      const notice = clicked.downloads?.[0] ?? (await client.read(pageId)).downloads?.[0];
      if (!notice) throw new Error('the worker did not report the fixture download');
      if (action === 'notice') expect(JSON.stringify(notice)).not.toContain(VALUE);
      else await expect(client.download(pageId, notice.id)).rejects.toThrow(/secret|private|sensitive/iu);
    });
  }

  it('inputShot: masks the field picture used by input cards', async () => {
    await fill('autocomplete="one-time-code"');
    const seen = await client.inputObserve(pageId, [{ id: 'value', target: FIELD }]);
    if (!seen.ok) throw new Error('synthetic field not observed');
    const shot = await client.inputShot(pageId, seen.facts);
    await blackAt(shot.pngBase64, 'png', 250 - shot.clip.x, 75 - shot.clip.y);
  });

  it('cropped screenshot: scrolls first and uses the same crop for pixels and masks', async () => {
    const { field } = await fill('autocomplete="one-time-code"');
    await field.evaluate(node => {
      node.style.top = '1500px';
      document.body.style.height = '2200px';
    });
    await blackAt((await client.screenshot(pageId, { target: FIELD })).screenshotBase64, 'png', 230, 35, false);
  });

  for (const fullPage of [false, true]) {
    it(`${fullPage ? 'full-page' : 'viewport'} screenshot: masks a scrolled, sticky field`, async () => {
      const { raw, field } = await fill('autocomplete="one-time-code"');
      await field.evaluate(node => {
        node.style.cssText =
          'position:fixed;left:30px;top:40px;width:240px;height:40px;background:magenta;color:magenta';
        document.body.style.height = '2200px';
      });
      await raw.evaluate(() => scrollTo(0, 1100));
      expect((await raw.screenshot()).byteLength).toBeGreaterThan(100);
      await noMagenta((await client.screenshot(pageId, { fullPage })).screenshotBase64);
    });
  }

  for (const place of ['main', 'cross']) {
    it(`moving screenshot: freezes compositor animation and JavaScript in ${place}`, async () => {
      const { field } = await fill('autocomplete="one-time-code"', place);
      await field.evaluate(node => {
        node.style.background = 'magenta';
        node.style.color = 'magenta';
        node.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], {
          duration: 50,
          iterations: Infinity,
          direction: 'alternate',
        });
        setInterval(() => {
          node.style.top = `${40 + Math.floor(Math.random() * 200)}px`;
        }, 0);
      });
      try {
        await noMagenta((await client.screenshot(pageId)).screenshotBase64);
      } catch (error) {
        expect(String(error)).toMatch(/withheld|changed during capture/u);
      }
    });
  }

  it('cross-origin OOPIF: masks its console text and its pixels', async () => {
    await fill('autocomplete="one-time-code"', 'cross');
    const { lifecycle } = await client.lifecycle(pageId, { op: 'console' });
    expect(lifecycle.text).toContain(SIGNAL);
    expect(lifecycle.text).not.toContain(VALUE);
    await blackAt((await client.screenshot(pageId)).screenshotBase64);
  });

  it('closed shadow DOM: discovers native fields and masks their pixels and text', async () => {
    const { raw } = await opened('autocomplete="one-time-code"', 'closed');
    const session = await context.newCDPSession(raw);
    const snapshot = await session.send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
    const doc = snapshot.documents[0];
    const index = doc?.nodes.attributes?.findIndex(attrs => attrs.some(at => snapshot.strings[at] === 'secret')) ?? -1;
    const id = doc?.nodes.backendNodeId?.[index];
    if (id === undefined) throw new Error('closed native field not found');
    await session.send('DOM.focus', { backendNodeId: id });
    await session.send('Input.insertText', { text: VALUE });
    expect(await raw.locator('body').getAttribute('data-inserted')).toBe(VALUE);
    expect(await raw.locator('body').getAttribute('data-trusted')).toBe('true');
    const result = await client.evaluate(pageId, { source: '() => document.body.dataset.inserted' });
    expect(result.text).not.toContain(VALUE);
    await blackAt((await client.screenshot(pageId)).screenshotBase64);
    await session.detach();
  });

  it('viewer dispatch: ordinary non-sensitive typing remains visible', async () => {
    const { raw, field, reflected } = await opened('type="text"');
    await field.click();
    const value = 'ordinary viewer query';
    await client.dispatchInput(pageId, { kind: 'insertText', text: value });
    expect(await field.inputValue()).toBe(value);
    expect(await reflected.innerText()).toBe(`${SIGNAL} ${value}`);
    expect(await raw.locator('body').getAttribute('data-trusted')).toBe('true');
    expect((await client.read(pageId)).text).toContain(value);
  });

  it('ordinary JSON/HTML/URL/form encodings: mask before representation and clipping', async () => {
    const value = 'synthetic-"\\&+/?= snow☃';
    const { raw, field } = await fill(PASSWORD, 'main', value);
    const evaluated = await client.evaluate(pageId, {
      source: '() => [document.querySelector("#secret").value, document.documentElement.outerHTML]',
    });
    expect(evaluated.text).not.toContain(JSON.stringify(value).slice(1, -1));
    expect(evaluated.text).toContain('[redacted]');
    await field.evaluate(node => {
      history.replaceState({}, '', `/encoded?${new URLSearchParams({ value: (node as HTMLInputElement).value })}`);
    });
    expect(raw.url()).toContain('encoded?');
    const output = await client.location(pageId).then(
      result => JSON.stringify(result),
      (error: unknown) => {
        const message = String(error);
        expect(message).toContain('related pages changed during sensitive field inspection');
        return message;
      },
    );
    expect(output).not.toContain(value);
    expect(output).not.toContain(JSON.stringify(value).slice(1, -1));
    expect(output).not.toContain(new URLSearchParams({ value }).toString().slice(6));
  });

  it('page read and eval: mask a whole value before the output limit can cut it', async () => {
    const { reflected } = await fill();
    await reflected.evaluate((node, value) => {
      node.textContent = 'x'.repeat(199_990) + value;
    }, VALUE);
    const read = await client.read(pageId);
    expect(read.text).toContain('[redacted]');
    expect(read.text).not.toContain(VALUE.slice(0, 8));
    const evaluated = await client.evaluate(pageId, {
      source: '() => "x".repeat(199990) + document.querySelector("#secret").value',
    });
    expect(evaluated.text).not.toContain(VALUE.slice(0, 8));
  });

  it('network body: masks a whole value before the byte limit can cut it', async () => {
    const { raw } = await fill();
    const response = raw.waitForResponse(`${ORIGIN}/large`);
    await raw.evaluate(() => {
      void fetch('/large');
    });
    await (await response).finished();
    const { lifecycle: list } = await client.lifecycle(pageId, { op: 'network', action: 'list', filter: '/large' });
    const id = list.text.split(' ')[0];
    if (!id) throw new Error('large response was not logged');
    const { lifecycle } = await client.lifecycle(pageId, { op: 'network', action: 'get', id });
    expect(lifecycle.text).not.toContain(VALUE.slice(0, 8));
  });

  it('dialog and exception captures: mask a value before first-line limits', async () => {
    const { raw } = await fill();
    const dialog = raw.waitForEvent('dialog');
    void raw.evaluate(() => alert(document.querySelector<HTMLInputElement>('#secret')?.value)).catch(() => undefined);
    await dialog;
    const answer = await client.lifecycle(pageId, { op: 'dialog', action: 'dismiss' });
    expect(JSON.stringify(answer)).not.toContain(VALUE);
    try {
      await client.evaluate(pageId, { source: '() => { throw new Error(document.querySelector("#secret").value); }' });
      throw new Error('the script did not throw');
    } catch (error) {
      expect(String(error)).toContain('[redacted]');
      expect(String(error)).not.toContain(VALUE);
    }
  });

  it('download and PDF: stay refused after clearing, navigation and the five-second cleanup deadline', async () => {
    const { raw, field } = await fill();
    const download = raw.waitForEvent('download');
    const result = await client.click(pageId, { kind: 'selector', selector: '#download' });
    await download;
    await field.fill('');
    await raw.evaluate(() => {
      const echo = document.querySelector('#echo');
      if (echo) echo.textContent = '';
    });
    await raw.waitForTimeout(5100);
    await client.navigate(pageId, `${ORIGIN}/clean`);
    await expect(client.download(pageId, result.downloads?.[0]?.id)).rejects.toThrow(/sensitive/u);
    await expect(client.pdf(pageId)).rejects.toThrow(/sensitive/u);
    expect(await readdir(join(root, 'stage')).catch(() => [])).toEqual([]);
  }, 15_000);

  it('late eval and exception values: discover native secrets before the first output limit', async () => {
    const { raw } = await opened();
    const value = 'late-native-synthetic-G27-928413';
    const setup = `const f=document.createElement('input');f.type='password';f.value=${JSON.stringify(value)};document.body.append(f);`;
    const reply = await client.evaluate(pageId, { source: `() => { ${setup} return 'x'.repeat(199990)+f.value; }` });
    expect(await raw.locator('input').last().inputValue()).toBe(value);
    expect(reply.text).not.toContain(value.slice(0, 8));
    const other = 'late-exception-synthetic-G27-482999';
    try {
      await client.evaluate(pageId, {
        source: `() => { const f=document.createElement('input');f.type='password';f.value=${JSON.stringify(other)};document.body.append(f);throw new Error(f.value); }`,
      });
      throw new Error('script did not throw');
    } catch (error) {
      expect(String(error)).toContain('[redacted]');
      expect(String(error)).not.toContain(other);
    }
  });

  it('context taint: related fresh pages stay refused; an isolated context can still export', async () => {
    const { raw } = await fill();
    await client.read(pageId);
    const sourceId = pageId;
    const fresh = await client.newPage({ url: `${ORIGIN}/fresh` });
    pageId = fresh.actedPageId;
    await expect(client.pdf(pageId)).rejects.toThrow(/restart this identity/u);
    await client.closePage(sourceId);
    await client.closePage(pageId);
    const isolated = await client.newPage({ url: `${ORIGIN}/isolated`, incognito: true });
    pageId = isolated.actedPageId;
    expect((await client.pdf(pageId)).staged.size).toBeGreaterThan(100);
    expect(raw.isClosed()).toBe(true);
  });

  it('dialog dismissal remains available while a renderer writer is waiting on the dialog', async () => {
    const { raw } = await opened();
    const seen = raw.waitForEvent('dialog');
    const waiting = client.evaluate(pageId, { source: '() => { alert("synthetic dialog"); return true; }' });
    await seen;
    const dismissed = await client.lifecycle(pageId, { op: 'dialog', action: 'dismiss' });
    expect(dismissed.lifecycle.text).toContain('dismissed');
    await waiting;
    expect((await client.read(pageId)).text).toContain(SIGNAL);
  });

  it('ordinary viewer keystrokes and Enter do not corrupt reads or taint export', async () => {
    pageId = (await client.newPage({ url: `${ORIGIN}/?attributes=type%3D%22text%22`, incognito: true })).actedPageId;
    await client.click(pageId, FIELD);
    for (const text of ['j', ' ', 'ordinary query']) await client.dispatchInput(pageId, { kind: 'insertText', text });
    await client.dispatchInput(pageId, {
      kind: 'key',
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      text: '\r',
      windowsVirtualKeyCode: 13,
    });
    expect((await client.evaluate(pageId, { source: '() => document.querySelector("#secret").value' })).text).toBe(
      '"j ordinary query"',
    );
    expect((await client.read(pageId)).text).toContain('j ordinary query');
    expect((await client.pdf(pageId)).staged.size).toBeGreaterThan(100);
  });

  for (const fullPage of [false, true])
    it(`viewport-dependent fields stay masked in ${fullPage ? 'full-page' : 'viewport'} pixels`, async () => {
      const { field } = await fill('autocomplete="one-time-code"');
      await field.evaluate(node => {
        const box = document.createElement('div');
        box.style.cssText = 'min-height:100vh;display:flex;align-items:center;justify-content:center';
        node.style.cssText = 'position:static;width:240px;height:40px;background:magenta;color:magenta';
        box.append(node);
        document.body.prepend(box);
        document.body.style.height = '2400px';
        const bottom = document.createElement('input');
        bottom.type = 'text';
        bottom.autocomplete = 'current-password';
        bottom.value = node instanceof HTMLInputElement ? node.value : '';
        bottom.style.cssText =
          'position:fixed;top:auto;bottom:0;left:20px;width:240px;height:40px;background:magenta;color:magenta';
        document.body.append(bottom);
      });
      await noMagenta((await client.screenshot(pageId, { fullPage })).screenshotBase64);
    });

  it('smooth compositor scrolling is stopped before measuring a fresh capture', async () => {
    const { raw, field } = await fill('autocomplete="one-time-code"');
    await field.evaluate(node => {
      node.style.top = '1100px';
      node.style.background = 'magenta';
      node.style.color = 'magenta';
      document.body.style.height = '3000px';
    });
    await raw.evaluate(() => scrollTo({ top: 800, behavior: 'smooth' }));
    await raw.waitForFunction(() => scrollY > 400);
    await noMagenta((await client.screenshot(pageId)).screenshotBase64);
  });

  it('native typing replaces prefixes, leaves ordinary text readable, and scopes masks to its context', async () => {
    const { raw, field } = await opened();
    await raw.evaluate(() => {
      const ordinary = document.createElement('input');
      ordinary.id = 'ordinary';
      ordinary.value = 'hello ordinary';
      ordinary.style.cssText = 'top:300px;background:magenta;color:magenta';
      document.body.append(ordinary);
      const prose = document.createElement('p');
      prose.textContent = 'hello ordinary';
      document.body.append(prose);
    });
    await client.click(pageId, FIELD);
    let inserted = '';
    for (const text of 'hunter2') {
      inserted += text;
      await client.dispatchInput(pageId, { kind: 'insertText', text });
      expect(await field.inputValue()).toBe(inserted);
      expect((await client.read(pageId)).text).toContain('hello ordinary');
    }
    expect((await client.evaluate(pageId, { source: '() => document.querySelector("#secret").value' })).text).toBe(
      '"[redacted]"',
    );
    expect((await client.evaluate(pageId, { source: '() => "hello hunter"' })).text).toBe('"hello hunter"');
    const source = pageId;
    pageId = (await client.newPage({ url: `${ORIGIN}/native-isolated`, incognito: true })).actedPageId;
    await client.evaluate(pageId, { source: '() => { document.body.textContent = "hello hunter2"; }' });
    expect((await client.read(pageId)).text).toContain('hello hunter2');
    expect((await client.pdf(pageId)).staged.size).toBeGreaterThan(100);
    await client.closePage(source);
  });

  it('a one-character native secret does not taint an unrelated isolated context', async () => {
    await fill(PASSWORD, 'main', 'a');
    await client.read(pageId);
    const source = pageId;
    pageId = (await client.newPage({ url: `${ORIGIN}/isolated-short`, incognito: true })).actedPageId;
    expect((await client.pdf(pageId)).staged.size).toBeGreaterThan(100);
    await client.closePage(source);
  });
});
