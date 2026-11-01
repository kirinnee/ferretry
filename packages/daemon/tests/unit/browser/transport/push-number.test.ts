import { afterEach, describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Element, Window } from 'happy-dom';
import should from 'should';
import {
  identityProviderOf,
  numberSourceFits,
  readPointedNumber,
  scanPushNumber,
} from '../../../../src/lib/browser/transport/push-number.ts';

const FIXTURES = join(import.meta.dir, '../../../fixtures/push');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const opened: Window[] = [];
afterEach(async () => {
  for (const window of opened.splice(0)) await window.happyDOM.close();
});

/**
 * A page as the browser would hold it, in happy-dom. HAPPY-DOM DOES NO LAYOUT, so it is stubbed, and that stub is the
 * one assumption these tests make about a real browser: every element has its own small box (so the element at its
 * centre is itself), EXCEPT an element that is `hidden` or `display: none` (itself or an ancestor), which has no box,
 * and an element marked `data-covered`, whose centre something else sits on. `visibility: hidden` keeps its box and is
 * left to the computed style, as in a browser.
 */
function pageOf(html: string, url: string): Window {
  const window = new Window({
    url,
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
  opened.push(window);
  window.document.write(html);
  const indexOf = new WeakMap<object, number>();
  const byIndex: unknown[] = [];
  const hidden = (element: Element | null): boolean => {
    for (let node = element; node !== null; node = node.parentElement) {
      if (node.hasAttribute('hidden')) return true;
      if (/display:\s*none/u.test(node.getAttribute('style') ?? '')) return true;
    }
    return false;
  };
  const index = (element: object): number => {
    const known = indexOf.get(element);
    if (known !== undefined) return known;
    byIndex.push(element);
    indexOf.set(element, byIndex.length - 1);
    return byIndex.length - 1;
  };
  const prototype = window.HTMLElement.prototype as unknown as { getBoundingClientRect: () => unknown };
  prototype.getBoundingClientRect = function (this: Element) {
    if (hidden(this)) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: index(this) * 4, y: 0, width: 2, height: 2 };
  };
  const document = window.document as unknown as { elementFromPoint: (x: number, y: number) => unknown };
  document.elementFromPoint = (x: number) => {
    const element = byIndex[(x - 1) / 4] as Element | undefined;
    return element?.hasAttribute('data-covered') === true ? window.document.body : (element ?? null);
  };
  return window;
}

const scan = (html: string, url: string) => scanPushNumber({}, pageOf(html, url));

/** A small page around one snippet. */
const page = (body: string): string => `<!doctype html><html><body>${body}</body></html>`;

const MICROSOFT = 'https://login.microsoftonline.com/common/SAS/ProcessAuth';
const OKTA = 'https://example.okta.com/signin/verify/okta/push';
const GOOGLE = 'https://accounts.google.com/v3/signin/challenge/dp?TL=example';
const DUO = 'https://api-example.duosecurity.com/frame/v4/auth/prompt';

const okta = (number: string, said = number): string =>
  page(
    `<div id="okta-sign-in"><form data-se="o-form"><div class="number-challenge-section"><p>On your mobile device, open the Okta Verify prompt, then tap <span class="strong">${said}</span> in Okta Verify to continue.</p><span class="phone--number" data-se="challenge-number">${number}</span></div></form></div>`,
  );

describe('which identity provider a host is', () => {
  it("should know each provider's own sign-in hosts and an organisation's subdomain, and nothing that only looks like one", () => {
    // Arrange
    const known = {
      'login.microsoftonline.com': 'microsoft',
      'LOGIN.LIVE.COM': 'microsoft',
      'accounts.google.com': 'google',
      'example.okta.com': 'okta',
      'example.oktapreview.com': 'okta',
      'example.okta-emea.com': 'okta',
      'api-example.duosecurity.com': 'duo',
    };
    const lookAlikes = [
      'login.microsoftonline.com.evil.example',
      'evil-login.microsoftonline.co',
      'accounts.google.com.evil.example',
      'google.com',
      'okta.com',
      'evilokta.com',
      '.okta.com',
      'duosecurity.com',
      'evil-duosecurity.com',
      'login.company.com',
    ];

    // Act / Assert
    for (const [host, provider] of Object.entries(known)) should(identityProviderOf(host)).equal(provider);
    for (const host of lookAlikes) should(identityProviderOf(host)).be.undefined();
  });

  it("should fit a provider's number only to its own hosts, and an Okta or pointed number to any", () => {
    should(numberSourceFits('microsoft', 'login.live.com')).be.true();
    should(numberSourceFits('microsoft', 'login.microsoftonline.com.evil.example')).be.false();
    should(numberSourceFits('microsoft', 'accounts.google.com')).be.false();
    should(numberSourceFits('google', 'ACCOUNTS.GOOGLE.COM')).be.true();
    should(numberSourceFits('google', 'accounts.google.com.evil.example')).be.false();
    should(numberSourceFits('duo', 'api-example.duosecurity.com')).be.true();
    should(numberSourceFits('duo', 'evil-duosecurity.com')).be.false();
    should(numberSourceFits('duo', 'duosecurity.com')).be.false();
    should(numberSourceFits('okta', 'login.company.com')).be.true();
    should(numberSourceFits('pointed', 'login.company.com')).be.true();
  });
});

describe("reading the number off a provider's own page (captured-shape fixtures)", () => {
  it('should read Okta Gen2, Okta Gen3, Microsoft Entra, Google and Duo Verified Push from their pages', () => {
    should(scan(fixture('okta-gen2.html'), OKTA)).eql({ provider: 'okta', number: { value: '42', from: 'okta' } });
    should(scan(fixture('okta-gen3.html'), OKTA)).eql({ provider: 'okta', number: { value: '37', from: 'okta' } });
    should(scan(fixture('okta-gen3.html'), 'https://login.company.com/oauth2/v1/authorize')).eql({
      provider: 'okta',
      number: { value: '37', from: 'okta' },
    });
    should(scan(fixture('microsoft-entra.html'), MICROSOFT)).eql({
      provider: 'microsoft',
      number: { value: '58', from: 'microsoft' },
    });
    should(scan(fixture('microsoft-entra.html'), 'https://login.live.com/ppsecure/post.srf')).eql({
      provider: 'microsoft',
      number: { value: '58', from: 'microsoft' },
    });
    should(scan(fixture('google.html'), GOOGLE)).eql({ provider: 'google', number: { value: '63', from: 'google' } });
    should(scan(fixture('duo-universal.html'), DUO)).eql({ provider: 'duo', number: { value: '4831', from: 'duo' } });
  });

  it('should say whose challenge a page is with no number when the view is there but shows none, and nothing after it', () => {
    should(scan(fixture('okta-push-no-number.html'), OKTA)).eql({ missing: 'none-found' });
    should(scan(fixture('microsoft-kmsi.html'), MICROSOFT)).eql({ missing: 'none-found' });
    should(scan(page('<div id="idDiv_SAOTCAS_Title">Approve sign in request</div>'), MICROSOFT)).eql({
      provider: 'microsoft',
      missing: 'none-found',
    });
    should(scan(page('<p>Welcome</p>'), 'https://example.test/')).eql({ missing: 'none-found' });
  });

  it("should never read a provider's number on another host: an AitM proxy showing the real page gets none", () => {
    for (const proxy of [
      'https://login.microsoftonline.com.evil.example/common/SAS/ProcessAuth',
      'https://login-microsoftonline.evil.example/',
    ])
      should(scan(fixture('microsoft-entra.html'), proxy)).eql({ missing: 'none-found' });
    should(scan(fixture('google.html'), 'https://accounts.google.com.evil.example/v3/signin/challenge/dp')).eql({
      missing: 'none-found',
    });
    should(scan(fixture('duo-universal.html'), 'https://evil-duosecurity.com/frame/v4/auth/prompt')).eql({
      missing: 'none-found',
    });
  });

  it('should take no number from an element anyone can type into, a hidden or covered one, or one that is not only digits', () => {
    const cases = [
      `<input id="idRichContext_DisplaySign" value="42" />`,
      `<div id="idRichContext_DisplaySign" contenteditable="true">42</div>`,
      `<div contenteditable="true"><span id="idRichContext_DisplaySign">42</span></div>`,
      `<div id="idRichContext_DisplaySign" hidden>42</div>`,
      `<div id="idRichContext_DisplaySign" style="display: none">42</div>`,
      `<div id="idRichContext_DisplaySign" style="visibility: hidden">42</div>`,
      `<div id="idRichContext_DisplaySign" data-covered>42</div>`,
      `<div id="idRichContext_DisplaySign">42!</div>`,
      `<div id="idRichContext_DisplaySign">Tap 42</div>`,
      `<div id="idRichContext_DisplaySign">4242</div>`,
      `<div id="idRichContext_DisplaySign"></div>`,
    ];

    for (const html of cases)
      should(scan(page(html), MICROSOFT)).eql({ provider: 'microsoft', missing: 'none-found' }, html);
  });

  it('should read Okta only when the sentence and the number agree, and only from the widget', () => {
    should(scan(okta('42'), OKTA)).match({ number: { value: '42' } });
    should(scan(okta('42', '17'), OKTA)).eql({ provider: 'okta', missing: 'none-found' });
    should(scan(okta('4242'), OKTA)).eql({ provider: 'okta', missing: 'none-found' });
    should(scan(okta('42').replace('Okta Verify to', 'the app to'), OKTA)).eql({
      provider: 'okta',
      missing: 'none-found',
    });
    should(scan(okta('42').replace('data-se="challenge-number"', ''), OKTA)).eql({
      provider: 'okta',
      missing: 'none-found',
    });
    should(scan(okta('42').replace('id="okta-sign-in"', '').replace('data-se="o-form"', ''), OKTA)).eql({
      missing: 'none-found',
    });
    // Two numbers shown that disagree: none.
    const twice = okta('42').replace('</div></form>', '<span data-se="challenge-number">17</span></div></form>');
    should(scan(twice, OKTA)).eql({ provider: 'okta', missing: 'none-found' });
  });

  it('should read Google only on a challenge path, when every sentence names one number and an element shows it alone', () => {
    const google = (body: string): string => page(`<div role="main">${body}</div>`);
    const sentence = 'Tap Yes on the prompt, then tap 63 on your phone to verify it’s you.';
    should(scan(google(`<samp>63</samp><p>${sentence}</p>`), GOOGLE)).match({ number: { value: '63' } });
    should(scan(google(`<samp>63</samp><p>${sentence}</p>`), 'https://accounts.google.com/signin/v2/identifier')).eql({
      missing: 'none-found',
    });
    should(scan(google(`<samp>63</samp>`), GOOGLE)).eql({ missing: 'none-found' });
    // Two disagreeing numbers in the words: none, whatever is shown.
    should(scan(google(`<samp>63</samp><p>${sentence}</p><p>Or tap 17 on your device.</p>`), GOOGLE)).eql({
      provider: 'google',
      missing: 'none-found',
    });
    // The sentence alone, with nothing showing the number on its own: none.
    should(scan(google(`<p>${sentence}</p>`), GOOGLE)).eql({ provider: 'google', missing: 'none-found' });
    // Shown only inside an editable element, or in a cross-origin frame (never looked into): none.
    should(scan(google(`<div contenteditable="true">63</div><p>${sentence}</p>`), GOOGLE)).eql({
      provider: 'google',
      missing: 'none-found',
    });
    should(
      scan(google(`<iframe srcdoc="<samp>63</samp>" src="https://evil.example/"></iframe><p>${sentence}</p>`), GOOGLE),
    ).eql({ provider: 'google', missing: 'none-found' });
  });

  it('should read a Duo code of three to six digits under its own sentence, and nothing else', () => {
    const duo = (code: string, words = 'Enter code in Duo Mobile'): string =>
      page(`<p>${words}</p><div class="verification-code">${code}</div>`);
    for (const code of ['123', '4831', '123456']) should(scan(duo(code), DUO)).match({ number: { value: code } });
    for (const code of ['12', '1234567', 'abc'])
      should(scan(duo(code), DUO)).eql({ provider: 'duo', missing: 'none-found' });
    should(scan(duo('4831', 'Enter this verification code in Duo Mobile'), DUO)).match({ number: { value: '4831' } });
    should(scan(duo('4831', 'Check for a Duo Push'), DUO)).eql({ missing: 'none-found' });
    should(scan(duo('4831') + duo('9999'), DUO)).eql({ provider: 'duo', missing: 'none-found' });
  });

  it('should read another locale as no number (English only)', () => {
    const french = okta('42').replace(
      'On your mobile device, open the Okta Verify prompt, then tap',
      'Sur votre appareil mobile, ouvrez Okta Verify, puis appuyez sur',
    );
    should(scan(french.replace('in Okta Verify', 'dans Okta Verify'), OKTA)).eql({
      provider: 'okta',
      missing: 'none-found',
    });
  });
});

describe('reading the element a ferret pointed at', () => {
  const pointed = (html: string, url = 'https://login.example.test/') => {
    const window = pageOf(page(html), url);
    const element = window.document.querySelector('#n');
    return readPointedNumber(element, {}, window);
  };

  it('should read one to three digits from a visible element no one can type into', () => {
    should(pointed('<b id="n"> 17 </b>')).eql({ value: '17' });
  });

  it('should refuse a field, an editable element or one inside either as editable', () => {
    for (const html of [
      '<input id="n" value="17" />',
      '<textarea id="n">17</textarea>',
      '<select id="n"><option>17</option></select>',
      '<div id="n" contenteditable="true">17</div>',
      '<div contenteditable=""><b id="n">17</b></div>',
    ])
      should(pointed(html)).eql({ missing: 'editable' }, html);
  });

  it('should find none in a hidden, covered or invisible element, or in one that is not only one to three digits', () => {
    for (const html of [
      '<b id="n" hidden>17</b>',
      '<b id="n" style="visibility: hidden">17</b>',
      '<b id="n" data-covered>17</b>',
      '<b id="n">1234</b>',
      '<b id="n">17a</b>',
      '<b id="n"></b>',
    ])
      should(pointed(html)).eql({ missing: 'none-found' }, html);
  });

  it('should find none in an element that answers no box or has nothing at its centre', () => {
    const env = { document: {} };
    should(readPointedNumber({ tagName: 'B', innerText: '17' }, {}, env)).eql({ missing: 'none-found' });
    should(
      readPointedNumber(
        { tagName: 'B', textContent: '17', getBoundingClientRect: () => ({ x: 0, y: 0, width: 2, height: 2 }) },
        {},
        env,
      ),
    ).eql({ missing: 'none-found' });
  });
});
