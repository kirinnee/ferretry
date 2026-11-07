import { describe, it } from 'bun:test';
import should from 'should';
import { recogniseBrowserChallenge } from '../../../../src/lib/index.ts';

const page = (overrides: Partial<{ url: string; title: string; frameUrls: readonly string[] }> = {}) => ({
  url: 'https://shop.example/',
  title: 'Shop',
  frameUrls: [],
  ...overrides,
});

describe('recogniseBrowserChallenge', () => {
  it('should see nothing on an ordinary page', () => {
    // Act + Assert
    should(recogniseBrowserChallenge(page())).be.undefined();
    should(recogniseBrowserChallenge(page({ url: 'not a url', frameUrls: ['also not a url'] }))).be.undefined();
  });

  it('should recognise an interstitial that stands in for the page from its address or title', () => {
    // Act + Assert
    should(
      recogniseBrowserChallenge(page({ url: 'https://shop.example/cdn-cgi/challenge-platform/h/b/orchestrate' })),
    ).deepEqual({ provider: 'cloudflare' });
    should(recogniseBrowserChallenge(page({ title: 'Just a moment...' }))).deepEqual({ provider: 'cloudflare' });
    should(recogniseBrowserChallenge(page({ title: 'Attention Required! | Cloudflare' }))).deepEqual({
      provider: 'cloudflare',
    });
    should(recogniseBrowserChallenge(page({ url: 'https://www.google.com/sorry/index?continue=x' }))).deepEqual({
      provider: 'google',
    });
    should(recogniseBrowserChallenge(page({ url: 'https://www.google.co.uk/sorry/index' }))).deepEqual({
      provider: 'google',
    });
    should(recogniseBrowserChallenge(page({ title: 'Please verify you are a human' }))).deepEqual({
      provider: 'other',
    });
    should(recogniseBrowserChallenge(page({ title: 'Robot Check' }))).deepEqual({ provider: 'other' });
    // A Google page that is not the sorry page, and a sorry path on someone else's site, are just pages.
    should(recogniseBrowserChallenge(page({ url: 'https://www.google.com/search?q=sorry' }))).be.undefined();
    should(recogniseBrowserChallenge(page({ url: 'https://shop.example/sorry/' }))).be.undefined();
  });

  it('should recognise a visible captcha widget from the frames on the page', () => {
    // Arrange
    const frames: readonly (readonly [string, string])[] = [
      ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile', 'cloudflare'],
      ['https://www.google.com/recaptcha/api2/anchor?ar=1&k=key&size=normal', 'recaptcha'],
      ['https://www.recaptcha.net/recaptcha/enterprise/anchor?k=key', 'recaptcha'],
      ['https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=1', 'hcaptcha'],
      ['https://geo.captcha-delivery.com/captcha/?initialCid=x', 'datadome'],
      ['https://client-api.arkoselabs.com/fc/gc/?token=x', 'arkose'],
      ['https://demo.funcaptcha.com/fc/', 'arkose'],
      ['https://captcha.px-cdn.net/PX123/captcha.js', 'perimeterx'],
    ];

    // Act + Assert
    for (const [frame, provider] of frames)
      should(recogniseBrowserChallenge(page({ frameUrls: ['https://ads.example/frame', frame] }))).deepEqual({
        provider,
      });
  });

  it('should not flag a widget that is present but asks nobody anything', () => {
    // Arrange — invisible reCAPTCHA (v3), its hidden challenge frame, an invisible hCaptcha, PerimeterX's
    // sensor script host, and a look-alike host that only ends in a provider's name.
    const quiet = [
      'https://www.google.com/recaptcha/api2/anchor?ar=1&k=key&size=invisible',
      'https://www.google.com/recaptcha/api2/bframe?k=key',
      'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&size=invisible',
      'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=challenge',
      'https://client.px-cdn.net/PX123/main.min.js',
      'https://notarkoselabs.com/fc/',
    ];

    // Act + Assert
    for (const frame of quiet) should(recogniseBrowserChallenge(page({ frameUrls: [frame] }))).be.undefined();
  });
});
