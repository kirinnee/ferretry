import { afterAll, afterEach, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { launcherPorts, REAL_WORKER } from '../../support/process-workers.ts';
import { BrowserProfileStore } from '../../../daemon/worker/control/adapters/profile-store.ts';
import { NodeSessionBrowserLauncher } from '../../../daemon/worker/launcher.ts';
import type { BrowserAutomation } from '../../../daemon/pages/automation.ts';
import type { BrowserInputFacts, BrowserInputFieldsPort } from '../../../daemon/target/lib/contracts.ts';
import { BrowserSessionService } from '../../../daemon/pages/service.ts';
import { unprovenListenerProver } from '../../support/listener-prover.ts';

/**
 * A FIELD THE PAGE RE-RENDERED BETWEEN THE CARD AND THE SEND, IN A REAL CHROME (docs/input-requests.md, "When the target
 * changes"). A framework replaces an input as the owner reads the card: a new node behind the same selector, often with the
 * old text still in it. The browser half of "typed with no second send": the facts record what the page says the field is
 * (its `maxlength` and its label); a write bound to the OLD node still types nothing; the re-find finds the ONE replacement
 * by its identity, and a write bound to those facts types into it, replacing whatever it held; two look-alikes, or a
 * replacement that is not the same field, are never chosen. The real worker under Node, through the real client.
 */

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
const WORKERS = REAL_WORKER();
const TEXT = '482913';

const PAGE = `<html><head><title>Verify</title></head><body>
<form id="f" action="/" method="get" style="position:absolute;left:20px;top:40px">
  <input id="code" name="otp" type="text" maxlength="6" autocomplete="one-time-code" inputmode="numeric" aria-label="Verification code" style="width:160px;height:28px">
</form>
<label for="who" style="position:absolute;left:20px;top:120px">Your username</label>
<input id="who" name="who" type="text" style="position:absolute;left:20px;top:140px;width:160px;height:28px">
<form id="g" action="/ignored" method="post" style="position:absolute;left:20px;top:200px">
  <input id="g1" name="g1" type="text" style="width:160px;height:28px">
  <button type="submit" formaction="/other">Go</button>
</form>
<form id="h" action="/real" style="position:absolute;left:20px;top:260px">
  <input name="action" value="clobber"><input name="getAttribute" value="x"><input name="baseURI" value="y">
  <input id="h1" name="h1" type="text" style="width:160px;height:28px">
</form>
<script>
  // Counted in the DOM, which the worker's own isolated world can read: how many times anything was typed into a field.
  document.body.dataset.inputs = '0';
  document.addEventListener('input', () => { document.body.dataset.inputs = String(Number(document.body.dataset.inputs) + 1); }, true);
</script>
</body></html>`;

let root = '';
let site: ReturnType<typeof Bun.serve>;
let browser: BrowserSessionService;
let base = '';

async function onPage<T>(work: (driver: BrowserAutomation, pageId: string) => Promise<T>): Promise<T> {
  return await browser.inputOnPage('s1', 'verify', async (port: BrowserInputFieldsPort, pageId) =>
    work(port as BrowserAutomation, pageId),
  );
}

/** The page's re-renders, as the source of one script each (run in the page through DevTools, which reads the DOM). */
const RERENDER = `const old = document.querySelector('#code'); const next = old.cloneNode(false);`;
const swap = (stale: string): string =>
  `() => { ${RERENDER} next.value = ${JSON.stringify(stale)}; old.replaceWith(next); return true; }`;
const SWAP_TWO = `() => { ${RERENDER} old.replaceWith(next); next.after(next.cloneNode(false)); return true; }`;
const swapOther = (attribute: string, value: string): string =>
  `() => { ${RERENDER} next.setAttribute(${JSON.stringify(attribute)}, ${JSON.stringify(value)}); old.replaceWith(next); return true; }`;
const VALUES = `() => Array.from(document.querySelectorAll('#code')).map(n => n.value)`;
const INPUTS = `() => Number(document.body.dataset.inputs)`;

const pointer = (id: string, selector: string) => ({ id, target: { kind: 'selector' as const, selector } });
const CODE = [pointer('code', '#code')];

/** Runs `source` in the page and reads what it returned. */
async function run(source: string): Promise<unknown> {
  return await onPage(async (driver, pageId) => JSON.parse((await driver.evaluate(pageId, { source })).text));
}

async function look(pointers = CODE): Promise<BrowserInputFacts> {
  return await onPage(async (driver, pageId) => {
    const seen = await driver.inputObserve(pageId, pointers);
    if (!seen.ok) throw new Error(`the field was not seen: ${JSON.stringify(seen)}`);
    return seen.facts;
  });
}

const refind = async (card: BrowserInputFacts) =>
  await onPage(async (driver, pageId) => await driver.inputRefind(pageId, card, CODE));

const type = async (facts: BrowserInputFacts) =>
  await onPage(async (driver, pageId) => await driver.inputType(pageId, facts, [{ field: 'code', text: TEXT }], false));

/** The page as the card saw it: opened fresh, the code field observed. */
async function card(): Promise<BrowserInputFacts> {
  await browser.openPage('s1', 'verify', { url: `${base}/` });
  return await look();
}

describe.if(process.platform === 'linux')('a field the page re-rendered under the card, in a real Chrome', () => {
  beforeAll(async () => {
    if (chrome === null) throw new Error('this test needs a real Chrome on PATH');
    root = await mkdtemp(join(tmpdir(), 'ferretry-input-refind-'));
    site = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }),
    });
    base = `http://127.0.0.1:${String(site.port)}`;
    browser = new BrowserSessionService(
      { get: async id => (id === 's1' ? {} : undefined) },
      new NodeSessionBrowserLauncher(
        new BrowserProfileStore(root),
        WORKERS.start,
        launcherPorts(),
        {
          FY_CHROME_BIN: chrome,
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          FONTCONFIG_FILE: process.env.FONTCONFIG_FILE,
        },
        undefined,
        {
          mode: async () => 'headless',
          platform: 'linux',
          transport: async () => 'port',
          listenerProver: unprovenListenerProver(),
        },
      ),
      () => Date.now(),
    );
  }, 60_000);

  afterEach(async () => {
    await browser.closePage('s1', 'verify').catch(() => undefined);
  });

  afterAll(async () => {
    await browser?.closeAll();
    site?.stop(true);
    if (root !== '') await rm(root, { recursive: true, force: true });
  });

  it('should record the maxlength and the label the page shows, whichever way the page gives the label', async () => {
    await browser.openPage('s1', 'verify', { url: `${base}/` });

    const facts = await look([pointer('code', '#code'), pointer('who', '#who')]);

    const [code, who] = facts.fields;
    should(code?.field).eql({
      tag: 'input',
      type: 'text',
      autocomplete: 'one-time-code',
      name: 'otp',
      id: 'code',
      inputmode: 'numeric',
      maxlength: '6',
      label: 'Verification code',
      formId: 'f',
      formAction: `${base}/`,
    });
    // A `<label for>` is read too, a field with no maxlength records none, and one outside any form names no form.
    should(who?.field).eql({ tag: 'input', type: 'text', name: 'who', id: 'who', label: 'Your username' });
    // The DevTools frame and loader come from the Page frame tree: the main frame's loader IS the document's id.
    should(code?.ownerLoader).equal(facts.navigationId);
    should(typeof code?.ownerFrame).equal('string');
    should(code?.ownerFrame).equal(who?.ownerFrame);
    should(code?.unread).be.undefined();
  }, 60_000);

  it("should read where a form really sends what is typed: the default button's formaction, and a form its own children cannot clobber", async () => {
    await browser.openPage('s1', 'verify', { url: `${base}/` });

    const facts = await look([pointer('g', '#g1'), pointer('h', '#h1')]);

    const [g, h] = facts.fields;
    should([g?.field.formId, g?.field.formAction]).eql(['g', `${base}/other`]);
    // `form.action`, `form.getAttribute` and `document.baseURI` are named by children here; the read never asks them.
    should([h?.field.formId, h?.field.formAction]).eql(['h', `${base}/real`]);
  }, 60_000);

  it('should type nothing when the form now sends the value to another action, or the field moved into another document', async () => {
    const shown = await card();

    await run(
      `() => { document.querySelector('#f').setAttribute('action', 'https://evil.example/collect'); return true; }`,
    );
    should(await type(shown)).equal('target_changed');
    should(await run(INPUTS)).equal(0);
    await run(`() => { document.querySelector('#f').setAttribute('action', '/'); return true; }`);

    await run(`() => { document.querySelector('#code').setAttribute('aria-label', 'Card number'); return true; }`);
    should(await type(shown)).equal('target_changed');
    await run(
      `() => { document.querySelector('#code').setAttribute('aria-label', 'Verification code'); return true; }`,
    );
    // Nothing but a restored page is the page the card showed: the same node types again.
    should(await type(shown)).equal('typed');
    should(await run(INPUTS)).equal(1);
  }, 60_000);

  it('should type nothing into the SAME node once it was adopted into a same-origin iframe', async () => {
    const shown = await card();
    await run(
      `() => { const frame = document.createElement('iframe'); document.body.append(frame); const node = document.querySelector('#code'); frame.contentDocument.body.append(frame.contentDocument.adoptNode(node)); return true; }`,
    );

    // The node, its tag, its attributes and its session are what they were; the document and frame it is in are not.
    should(await type(shown)).equal('target_changed');
    should(await run(INPUTS)).equal(0);
  }, 60_000);

  it('should keep producing the facts the seam test of the Vault is fed (real-chrome-facts.json): same fields, same kinds of value', async () => {
    const shape = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(shape)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, inner]) => [key, shape(inner)]),
            )
          : typeof value;
    const captured = JSON.parse(
      await Bun.file(
        new URL('../../../../../core/vault/tests/unit/daemon/inputs/real-chrome-facts.json', import.meta.url),
      ).text(),
    ) as Record<'replaced' | 'ambiguous', { shown: unknown; found: unknown; ambiguous?: true }>;

    const first = await card();
    await run(swap('OLD-STALE'));
    const replaced = await refind(first);
    await browser.closePage('s1', 'verify').catch(() => undefined);
    const second = await card();
    await run(SWAP_TWO);
    const two = await refind(second);

    should(shape(first)).eql(shape(captured.replaced.shown));
    should(shape(replaced.ok ? replaced.facts : replaced)).eql(shape(captured.replaced.found));
    should(shape(second)).eql(shape(captured.ambiguous.shown));
    should(shape(two.ok ? two.facts : two)).eql(shape(captured.ambiguous.found));
    should(two.ok && two.ambiguous).equal(captured.ambiguous.ambiguous);
  }, 60_000);

  it('should type into the ONE replacement, once, replacing the stale text, with no second send', async () => {
    const shown = await card();
    await run(swap('OLD-STALE'));
    should(await run(VALUES)).eql(['OLD-STALE']);

    // A write bound to the node the card showed is still refused: the old facts name a node that is gone.
    should(await type(shown)).equal('target_changed');
    should(await run(INPUTS)).equal(0);

    const found = await refind(shown);
    if (!found.ok) throw new Error(`not re-found: ${JSON.stringify(found)}`);
    const [was] = shown.fields;
    const [now] = found.facts.fields;
    should(now?.backendNodeId).not.equal(was?.backendNodeId);
    should(now?.field).eql(was?.field);
    // Near where it was: the Vault judges how near before it types.
    should(Math.abs((now?.box.x ?? 0) - (was?.box.x ?? 1000))).be.below(2);
    should(Math.abs((now?.box.y ?? 0) - (was?.box.y ?? 1000))).be.below(2);

    should(await type(found.facts)).equal('typed');
    should(await run(VALUES)).eql([TEXT]);
    // One insertion: what was selected was replaced, the field was not typed into twice.
    should(await run(INPUTS)).equal(1);
  }, 60_000);

  it('should find the replacement with nothing stale in it, and type into it too', async () => {
    const shown = await card();
    await run(swap(''));

    const found = await refind(shown);
    if (!found.ok) throw new Error(`not re-found: ${JSON.stringify(found)}`);
    should(await type(found.facts)).equal('typed');
    should(await run(VALUES)).eql([TEXT]);
  }, 60_000);

  it('should show a candidate, flagged ambiguous, when two elements look like the field: nothing typed', async () => {
    const shown = await card();
    await run(SWAP_TWO);

    const found = await refind(shown);

    should(found.ok && found.ambiguous).equal(true);
    should(found.ok && found.facts.fields.length).equal(1);
    should(await run(VALUES)).eql(['', '']);
    should(await run(INPUTS)).equal(0);
  }, 60_000);

  it('should hand the Vault a replacement whose label is not what the card showed, to decide: it is not dropped', async () => {
    const shown = await card();
    await run(swapOther('aria-label', 'Password'));

    const found = await refind(shown);

    should(found.ok && found.ambiguous).not.equal(true);
    should(found.ok && found.facts.fields[0]?.field.label).equal('Password');
    should(found.ok && shown.fields[0]?.field.label).equal('Verification code');
    should(await run(INPUTS)).equal(0);
  }, 60_000);

  for (const [what, attribute, value] of [
    ['its maxlength', 'maxlength', '8'],
    ['its autocomplete', 'autocomplete', 'off'],
    ['its name', 'name', 'password'],
  ] as const)
    it(`should not call a replacement the same field when ${what} is not what the card showed`, async () => {
      const shown = await card();
      await run(swapOther(attribute, value));

      const found = await refind(shown);

      should(found).eql({ ok: false, missing: 'code' });
      should(await run(INPUTS)).equal(0);
    }, 60_000);
});
