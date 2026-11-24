import { afterEach, describe, it } from 'bun:test';
import { Window } from 'happy-dom';
import should from 'should';
import { injectCaptchaToken, probeCaptcha } from '../../../daemon/challenges/solver-page.ts';
import type { PushNumberPage } from '../../../daemon/challenges/push-number-read.ts';
import { BROWSER_INPUT_WORKER_METHODS } from '../../../daemon/target/lib/contracts.ts';
import { type InputWorkerPages, serveInputMethod } from '../../../daemon/target/lib/worker-serve.ts';

const TOKEN = '0.TOKEN-issued-by-the-vendor-0123456789';
const SITE = '0x4AAAAAAAdemoSiteKeyForTurnstile';
const V2 = '6LdemoSiteKeyForRecaptchaVersionTwo_abcdef123';
const V3 = '6LdemoSiteKeyForRecaptchaVersionThree_abc12';
const HC = '10000000-ffff-ffff-ffff-000000000001';
const URL_OF_PAGE = 'https://app.example.test/login';

const opened: Window[] = [];
afterEach(async () => {
  for (const window of opened.splice(0)) await window.happyDOM.close();
});

function pageOf(html: string): Window {
  const window = new Window({
    url: URL_OF_PAGE,
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
      },
    },
  });
  window.document.write(`<html><body>${html}</body></html>`);
  opened.push(window);
  return window;
}

const GLOBALS = ['document', 'window', 'location', 'Event'] as const;

/** Runs `work` as the page's own script would: the page's `document`, `window`, `location` and `Event` are the globals. */
function inside<T>(window: Window, work: () => T): T {
  const held = GLOBALS.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const stand = { document: window.document, window, location: window.location, Event: window.Event };
  for (const name of GLOBALS)
    Object.defineProperty(globalThis, name, { value: stand[name], configurable: true, writable: true });
  try {
    return work();
  } finally {
    for (const [name, descriptor] of held)
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, descriptor);
  }
}

const probe = (html: string) => inside(pageOf(html), probeCaptcha);

describe('reading the check a page shows', () => {
  it('should name a Turnstile box by its key and action, or by the key in its frame’s address', () => {
    should(probe(`<div class="cf-turnstile" data-sitekey="${SITE}" data-action="login"></div>`)).eql({
      kind: 'turnstile',
      siteKey: SITE,
      action: 'login',
    });
    should(probe(`<div class="cf-turnstile" data-sitekey="${SITE}"></div>`)).eql({ kind: 'turnstile', siteKey: SITE });
    should(
      probe(
        `<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x/${SITE}/light/"></iframe>`,
      ),
    ).eql({ kind: 'turnstile', siteKey: SITE });
    should(
      probe(
        '<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></iframe>',
      ),
    ).be.null();
    should(probe(`<div class="cf-turnstile" data-sitekey="  "></div>`)).be.null();
  });

  it('should name an hCaptcha box by its key, or by the key in its frame’s address', () => {
    should(probe(`<div class="h-captcha" data-sitekey="${HC}"></div>`)).eql({ kind: 'hcaptcha', siteKey: HC });
    should(
      probe(
        `<iframe src="https://newassets.hcaptcha.com/captcha/v1/a/static/hcaptcha.html#frame=checkbox&sitekey=${HC}"></iframe>`,
      ),
    ).eql({
      kind: 'hcaptcha',
      siteKey: HC,
    });
    should(probe('<iframe src="https://newassets.hcaptcha.com/captcha/v1/a/static/hcaptcha.html"></iframe>')).be.null();
  });

  it('should tell reCAPTCHA v2 from v3 by what the page loaded and showed', () => {
    should(probe(`<div class="g-recaptcha" data-sitekey="${V2}"></div>`)).eql({ kind: 'recaptcha-v2', siteKey: V2 });
    should(probe(`<iframe src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=${V2}&size=normal"></iframe>`)).eql({
      kind: 'recaptcha-v2',
      siteKey: V2,
    });
    should(
      probe(
        `<script src="https://www.google.com/recaptcha/api.js?render=${V3}"></script><iframe src="https://www.google.com/recaptcha/api2/anchor?k=${V3}&size=invisible"></iframe>`,
      ),
    ).eql({ kind: 'recaptcha-v3', siteKey: V3 });
    should(
      probe(
        `<script src="https://www.google.com/recaptcha/enterprise.js?render=${V3}"></script><form data-action="submit_login"></form>`,
      ),
    ).eql({ kind: 'recaptcha-v3', siteKey: V3, action: 'submit_login' });
    should(probe('<script src="https://www.google.com/recaptcha/api.js?render=explicit"></script>')).be.null();
    should(probe('<script src="https://www.google.com/recaptcha/api.js"></script>')).be.null();
    should(probe(`<iframe src="https://www.google.com/recaptcha/api2/anchor?k=${V2}&size=invisible"></iframe>`)).eql({
      kind: 'recaptcha-v2',
      siteKey: V2,
    });
    should(probe('<iframe src="https://www.google.com/recaptcha/api2/anchor?size=invisible"></iframe>')).be.null();
  });

  it('should find nothing on a page with no solvable check, or with a frame whose address will not parse', () => {
    should(probe('<p>Hello</p>')).be.null();
    should(probe('<iframe></iframe><script src="/app.js"></script>')).be.null();
    should(probe('<iframe src="https://[bad/recaptcha/api2/anchor?k=x"></iframe>')).be.null();
  });
});

describe('handing a token to the widget', () => {
  const inject = (window: Window, kind: Parameters<typeof injectCaptchaToken>[0]['kind']) =>
    inside(window, () => injectCaptchaToken({ kind, token: TOKEN, origin: new URL(URL_OF_PAGE).origin }));
  const fieldValue = (page: Window, name: string): string | undefined =>
    (page.document.querySelector(`[name="${name}"]`) as unknown as { value?: string } | null)?.value;

  it('should fill the response field the page already has, tell the page, and call the widget’s callback', () => {
    const window = pageOf(
      `<div class="cf-turnstile" data-sitekey="${SITE}" data-callback="onDone"><input type="hidden" name="cf-turnstile-response"></div>`,
    );
    const heard: string[] = [];
    const calls: string[] = [];
    window.document.addEventListener('input', event => heard.push((event.target as unknown as { name: string }).name));
    (window as unknown as Record<string, unknown>).onDone = (token: string) => calls.push(token);

    should(inject(window, 'turnstile')).be.true();

    should(fieldValue(window, 'cf-turnstile-response')).equal(TOKEN);
    should(heard).eql(['cf-turnstile-response']);
    should(calls).eql([TOKEN]);
  });

  it('should make the field when the widget has not rendered one, in the box, else the form or the frame’s parent', () => {
    const box = pageOf(`<div class="cf-turnstile" data-sitekey="${SITE}"></div>`);
    should(inject(box, 'turnstile')).be.true();
    should(box.document.querySelector('.cf-turnstile')?.querySelector('[name="cf-turnstile-response"]')).not.be.null();

    const hc = pageOf(`<div class="h-captcha" data-sitekey="${HC}"></div>`);
    should(inject(hc, 'hcaptcha')).be.true();
    should(fieldValue(hc, 'h-captcha-response')).equal(TOKEN);
    should(fieldValue(hc, 'g-recaptcha-response')).equal(TOKEN);

    const form = pageOf(`<form><iframe src="https://challenges.cloudflare.com/x/${SITE}/"></iframe></form>`);
    should(inject(form, 'turnstile')).be.true();
    should(form.document.querySelector('form')?.querySelector('[name="cf-turnstile-response"]')).not.be.null();

    const framed = pageOf(
      `<div id="holder"><iframe src="https://www.google.com/recaptcha/api2/anchor?k=${V2}"></iframe></div>`,
    );
    should(inject(framed, 'recaptcha-v2')).be.true();
    should(framed.document.querySelector('#holder')?.querySelector('[name="g-recaptcha-response"]')).not.be.null();

    const v3 = pageOf('<form></form>');
    should(inject(v3, 'recaptcha-v3')).be.true();
  });

  it('should say no when the page has nowhere to put the token', () => {
    should(inject(pageOf('<p>Hello</p>'), 'turnstile')).be.false();
    should(inject(pageOf('<iframe src="https://example.test/x"></iframe>'), 'recaptcha-v2')).be.false();
  });

  it('should reach the callback reCAPTCHA keeps in its own table, and carry on past one that throws', () => {
    const window = pageOf(
      `<div class="g-recaptcha" data-sitekey="${V2}" data-callback="missing"><textarea name="g-recaptcha-response"></textarea></div>`,
    );
    const calls: string[] = [];
    const tooDeep = { a: { b: { c: { d: { e: { callback: () => calls.push('too deep') } } } } } };
    (window as unknown as Record<string, unknown>).___grecaptcha_cfg = {
      clients: {
        0: { aa: { bb: { callback: (token: string) => calls.push(token) } }, name: 'x', empty: null },
        1: {
          callback: () => {
            throw new Error('the page’s own callback failed');
          },
        },
        2: tooDeep,
      },
    };

    should(inject(window, 'recaptcha-v2')).be.true();

    should(calls).eql([TOKEN]);
    should(fieldValue(window, 'g-recaptcha-response')).equal(TOKEN);
    const bare = pageOf(`<div class="g-recaptcha" data-sitekey="${V2}"></div>`);
    (bare as unknown as Record<string, unknown>).___grecaptcha_cfg = {
      clients: {
        0: {
          callback: () => {
            throw new Error('no');
          },
        },
      },
    };
    should(inject(bare, 'recaptcha-v2')).be.true();
  });

  it('should say no when the only way in is a callback that throws', () => {
    const window = pageOf('<iframe src="https://example.test/x"></iframe>');
    (window as unknown as Record<string, unknown>).___grecaptcha_cfg = {
      clients: {
        0: {
          callback: () => {
            throw new Error('no');
          },
        },
      },
    };
    should(inject(window, 'recaptcha-v3')).be.false();
  });

  it('should hand nothing to a page that is no longer on the origin the check was solved for', () => {
    const calls: string[] = [];
    const window = pageOf(
      `<div class="cf-turnstile" data-sitekey="${SITE}" data-callback="onDone"><input type="hidden" name="cf-turnstile-response"></div>`,
    );
    (window as unknown as Record<string, unknown>).onDone = (token: string) => calls.push(token);
    const asked = inside(window, () =>
      injectCaptchaToken({ kind: 'turnstile', token: TOKEN, origin: 'https://other.example.test' }),
    );
    should(asked).be.false();
    should(fieldValue(window, 'cf-turnstile-response')).equal('');
    should(calls).eql([]);
  });
});

describe('the worker serving a probe and an inject', () => {
  const serving = (window: Window, evaluates: 'page' | 'throws' = 'page') => {
    const page: PushNumberPage = {
      evaluate: async <R, A>(read: (argument: A) => R, argument: A): Promise<R> => {
        if (evaluates === 'throws') throw new Error('the page went away');
        return inside(window, () => read(argument));
      },
      url: () => URL_OF_PAGE,
    };
    const pages = { pushPage: () => page } as unknown as InputWorkerPages;
    return async (method: string, params: Record<string, unknown>) => await serveInputMethod(pages, method, params);
  };

  it('should answer the widget with the page’s address, or null when there is none or the page cannot be read', async () => {
    const window = pageOf(`<div class="cf-turnstile" data-sitekey="${SITE}"></div>`);
    should(await serving(window)(BROWSER_INPUT_WORKER_METHODS.captchaProbe, { pageId: 'p1' })).eql({
      widget: { kind: 'turnstile', siteKey: SITE, pageUrl: URL_OF_PAGE },
    });
    should(await serving(pageOf('<p>x</p>'))(BROWSER_INPUT_WORKER_METHODS.captchaProbe, { pageId: 'p1' })).eql({
      widget: null,
    });
    should(await serving(window, 'throws')(BROWSER_INPUT_WORKER_METHODS.captchaProbe, { pageId: 'p1' })).eql({
      widget: null,
    });
  });

  it('should answer only whether the page took the token, and never echo it', async () => {
    const window = pageOf(`<div class="cf-turnstile" data-sitekey="${SITE}"></div>`);
    const serve = serving(window);
    const asked = (params: Record<string, unknown>) =>
      serve(BROWSER_INPUT_WORKER_METHODS.captchaInject, { pageId: 'p1', ...params });
    should(await asked({ kind: 'turnstile', token: TOKEN, pageUrl: URL_OF_PAGE })).eql({ taken: true });
    should(await asked({ kind: 'turnstile', token: TOKEN, pageUrl: 'https://elsewhere.example.test/x' })).eql({
      taken: false,
    });
    should(await asked({ kind: 'turnstile', token: TOKEN })).eql({ taken: false });
    should(await asked({ kind: 'turnstile', token: TOKEN, pageUrl: 'not an address' })).eql({ taken: false });
    should(await asked({ kind: 'arkose', token: TOKEN, pageUrl: URL_OF_PAGE })).eql({ taken: false });
    should(await asked({ kind: 'turnstile', token: '', pageUrl: URL_OF_PAGE })).eql({ taken: false });
    should(await asked({ kind: 'turnstile', token: 7, pageUrl: URL_OF_PAGE })).eql({ taken: false });
    should(
      await serving(window, 'throws')(BROWSER_INPUT_WORKER_METHODS.captchaInject, {
        pageId: 'p1',
        kind: 'turnstile',
        token: TOKEN,
        pageUrl: URL_OF_PAGE,
      }),
    ).eql({
      taken: false,
    });
  });
});
