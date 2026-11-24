import { describe, it } from 'bun:test';
import should from 'should';
import {
  type BrowserChallengeEvidence,
  isChallengedSubresource,
  recogniseBrowserChallenge,
  SubresourceChallenges,
} from '../../../daemon/challenges/recognise.ts';

const page = (overrides: Partial<BrowserChallengeEvidence> = {}): BrowserChallengeEvidence => ({
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

  it('I124 should recognise an interstitial that stands in for the page from its address or title', () => {
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

  it('I124 should recognise a visible captcha widget from the frames on the page', () => {
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

describe('recogniseBrowserChallenge: sub-request challenges', () => {
  const challenged = (...urls: string[]) => ({ challengedSubresources: urls });

  it('should recognise a first-party script or stylesheet answered with a challenge, even on a page with text', () => {
    // Act + Assert
    should(
      recogniseBrowserChallenge(page({ ...challenged('https://shop.example/app.js'), blankBody: true })),
    ).deepEqual({
      provider: 'cloudflare',
    });
    should(
      recogniseBrowserChallenge(page({ ...challenged('https://cdn.shop.example/app.css'), blankBody: false })),
    ).deepEqual({
      provider: 'cloudflare',
    });
    should(
      recogniseBrowserChallenge(
        page({ ...challenged('https://static.shop.co.uk/a.js'), url: 'https://www.shop.co.uk/' }),
      ),
    ).deepEqual({
      provider: 'cloudflare',
    });
  });

  it('should recognise a challenged third-party script only when the page has nothing to read', () => {
    // Act + Assert
    should(
      recogniseBrowserChallenge(page({ ...challenged('https://cdn.other.example/a.js'), blankBody: true })),
    ).deepEqual({
      provider: 'cloudflare',
    });
    should(
      recogniseBrowserChallenge(page({ ...challenged('https://cdn.other.example/a.js'), blankBody: false })),
    ).be.undefined();
    should(recogniseBrowserChallenge(page({ ...challenged('https://cdn.other.example/a.js') }))).be.undefined();
    // A look-alike host, and another registrable name under the same public suffix, are third parties.
    should(
      recogniseBrowserChallenge(page({ ...challenged('https://notshop.example/a.js'), blankBody: false })),
    ).be.undefined();
    should(
      recogniseBrowserChallenge(
        page({ ...challenged('https://other.co.uk/a.js'), url: 'https://shop.co.uk/', blankBody: false }),
      ),
    ).be.undefined();
  });

  it('should see nothing when no sub-request was challenged', () => {
    // Act + Assert
    should(recogniseBrowserChallenge(page({ challengedSubresources: [], blankBody: true }))).be.undefined();
  });

  it('should count only a 403 with a cf-mitigated challenge on a script or stylesheet', () => {
    // Arrange
    const answer = (type: string, status: number, headers: Record<string, string>) => ({ type, status, headers });

    // Act + Assert
    should(isChallengedSubresource(answer('script', 403, { 'cf-mitigated': 'challenge' }))).be.true();
    should(isChallengedSubresource(answer('stylesheet', 403, { 'CF-Mitigated': ' Challenge ' }))).be.true();
    should(isChallengedSubresource(answer('script', 403, {}))).be.false();
    should(isChallengedSubresource(answer('script', 403, { 'cf-mitigated': 'block' }))).be.false();
    should(isChallengedSubresource(answer('script', 200, { 'cf-mitigated': 'challenge' }))).be.false();
    should(isChallengedSubresource(answer('image', 403, { 'cf-mitigated': 'challenge' }))).be.false();
    should(isChallengedSubresource(answer('document', 403, { 'cf-mitigated': 'challenge' }))).be.false();
  });

  it('should tell sites apart by the public suffix list, private suffixes included', () => {
    // Arrange
    const onPage = (url: string, script: string) =>
      recogniseBrowserChallenge(page({ url, ...challenged(script), blankBody: false }));

    // Act + Assert — independent github.io tenants are third parties of each other
    should(onPage('https://alice.github.io/', 'https://mallory.github.io/a.js')).be.undefined();
    should(onPage('https://alice.github.io/', 'https://alice.github.io/a.js')).deepEqual({ provider: 'cloudflare' });
    // Sibling hosts under one registrable domain are first-party, however long the suffix.
    should(onPage('https://app.abc.de/', 'https://static.abc.de/a.js')).deepEqual({ provider: 'cloudflare' });
    should(onPage('https://www.shop.co.uk/', 'https://static.shop.co.uk/a.js')).deepEqual({ provider: 'cloudflare' });
    should(onPage('https://shop.co.uk/', 'https://other.co.uk/a.js')).be.undefined();
    // An address that has no registrable domain is only ever the same host.
    should(onPage('http://127.0.0.1:8080/', 'http://127.0.0.1:8080/a.js')).deepEqual({ provider: 'cloudflare' });
    should(onPage('http://127.0.0.1:8080/', 'http://localhost:8080/a.js')).be.undefined();
  });

  it('should keep a bounded record per kind, so trackers cannot hide a later first-party challenge', () => {
    // Arrange
    const record = new SubresourceChallenges();
    const document = 'https://shop.example/';

    // Act
    for (let each = 0; each < 40; each += 1) record.observe(`https://cdn.track.example/${String(each)}.js`, document);
    record.observe('https://shop.example/app.js', document);
    for (let each = 0; each < 40; each += 1) record.observe(`https://shop.example/${String(each % 20)}.css`, document);

    // Assert
    should(record.urls().length).equal(32);
    should(record.urls()).containEql('https://shop.example/app.js');
    should(recogniseBrowserChallenge(page({ challengedSubresources: record.urls(), blankBody: false }))).deepEqual({
      provider: 'cloudflare',
    });
  });

  it('should clear the record when the document a navigation asked for commits, and not before', () => {
    // Arrange
    const record = new SubresourceChallenges();
    const document = 'https://shop.example/';
    record.observe('https://shop.example/app.js', document);

    // Act + Assert — a navigation that never commits (an HTTP 204) keeps the current page's evidence
    record.navigating('https://shop.example/nothing', false);
    should(record.urls()).deepEqual(['https://shop.example/app.js']);
    // A same-document change (pushState) is no navigation at all
    record.committed('https://shop.example/route');
    should(record.urls()).deepEqual(['https://shop.example/app.js']);
    // A redirected navigation commits at the end of its chain
    record.navigating('https://shop.example/old', false);
    record.navigating('https://shop.example/new#top', true);
    record.committed('https://shop.example/new');
    should(record.urls()).deepEqual([]);
    // Chrome's error page is a committed document too
    record.observe('https://shop.example/b.js', document);
    record.navigating('https://down.example/', false);
    record.committed('chrome-error://chromewebdata/');
    should(record.urls()).deepEqual([]);
  });
});
