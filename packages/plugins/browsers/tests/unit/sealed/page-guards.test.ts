import { describe, it } from 'bun:test';
import should from 'should';
import {
  capturePendingRefusal,
  hostOfOrigin,
  pictureWithheld,
  SEALED_REFUSED_TOOLS,
  SealedPages,
  sealedPageRefusal,
} from '../../../daemon/sealed/page-guards.ts';

/** Never a real credential: the registry must never see it, and no sentence may carry it. */
const SENTINEL = 'FAKE-SC-7f3a91';

describe('which pages hold a sealed value', () => {
  it('should cover a page on the copy’s origin while the copy lives, and no page on another', () => {
    const pages = new SealedPages();
    pages.hold('f1', 'token', ['https://keys.example.test'], () => 5_000);

    should(pages.covering('f1', 'keys.example.test')).eql([
      { copy: 'token', from: ['https://keys.example.test'], until: 5_000, own: true },
    ]);
    should(pages.covering('f1', 'other.example.test')).eql([]);
    // The browser is ONE for every ferret: another ferret's page on the same site is covered too, and the copy is not its own.
    should(pages.covering('f2', 'keys.example.test')).eql([
      { copy: 'token', from: ['https://keys.example.test'], until: 5_000, own: false },
    ]);
  });

  it('should match by host and port, in any case, and not by the scheme', () => {
    const pages = new SealedPages();
    pages.hold('f1', 'token', ['http://127.0.0.1:8080'], () => 1);

    should(pages.covering('f1', '127.0.0.1:8080')).have.length(1);
    should(pages.covering('f1', '127.0.0.1:9090')).eql([]);
    should(pages.covering('f1', 'KEYS.EXAMPLE.TEST')).eql([]);
    pages.hold('f1', 'two', ['https://Keys.Example.test'], () => 1);
    should(pages.covering('f1', 'KEYS.example.TEST').map(cover => cover.copy)).eql(['two']);
  });

  it('should keep ONE record for a copy told again (a paste into another page), covering the origins of both', () => {
    const pages = new SealedPages();
    pages.hold('f1', 'token', ['https://keys.example.test'], () => 1);
    for (let paste = 0; paste < 50; paste += 1) pages.hold('f1', 'token', ['https://form.example.test'], () => 1);

    should(pages.covering('f1', 'keys.example.test')).have.length(1);
    should(pages.covering('f1', 'form.example.test')).have.length(1);
    should(pages.covering('f1', 'form.example.test')[0]?.from).eql([
      'https://keys.example.test',
      'https://form.example.test',
    ]);
  });

  it('should start afresh for a name made again after the copy ended', () => {
    const pages = new SealedPages();
    let ends: number | undefined = 1;
    pages.hold('f1', 'token', ['https://old.example.test'], () => ends);
    ends = undefined;

    pages.hold('f1', 'token', ['https://new.example.test'], () => 2);

    should(pages.covering('f1', 'old.example.test')).eql([]);
    should(pages.covering('f1', 'new.example.test')).have.length(1);
  });

  it('should end the moment the copy stops answering a time, so a discarded copy opens its pages at once', () => {
    const pages = new SealedPages();
    let ends: number | undefined = 9_000;
    pages.hold('f1', 'token', ['https://keys.example.test'], () => ends);
    should(pages.covering('f1', 'keys.example.test')).have.length(1);

    ends = undefined;

    should(pages.covering('f1', 'keys.example.test')).eql([]);
    should(pages.anyLive('f1')).equal(false);
  });

  it('should fail closed when the page’s host cannot be read, for a copy that has a page', () => {
    const pages = new SealedPages();
    pages.hold('f1', 'token', ['https://keys.example.test'], () => 1);

    should(pages.covering('f1', undefined)).have.length(1);
  });

  it('should keep a command’s copy (no page) live for picture checks and cover no page', () => {
    const pages = new SealedPages();
    pages.hold('f1', 'cli', [], () => 1);

    should(pages.anyLive('f1')).equal(true);
    should(pages.covering('f1', 'keys.example.test')).eql([]);
    should(pages.covering('f1', undefined)).eql([]);
  });

  it('should let go of everything a ferret held when its session ends, and of nobody else’s', () => {
    const pages = new SealedPages();
    pages.hold('f1', 'a', ['https://a.test'], () => 1);
    pages.hold('f2', 'b', ['https://a.test'], () => 1);
    const done = pages.capturing('f1');

    pages.drop('f1');

    should(pages.covering('f1', 'a.test').map(cover => cover.copy)).eql(['b']);
    should(pages.isCapturing('f1')).equal(false);
    should(pages.anyLive('f2')).equal(true);
    done();
  });

  it('should say a clipboard capture is running until every capture of that ferret has ended, once each', () => {
    const pages = new SealedPages();
    const first = pages.capturing('f1');
    const second = pages.capturing('f1');

    should(pages.isCapturing('f1')).equal(true);
    // The clipboard is the browser's, so a capture by anyone is a capture for every ferret's scripts.
    should(pages.isCapturing('f2')).equal(true);
    first();
    first();
    should(pages.isCapturing('f1')).equal(true);
    second();
    should(pages.isCapturing('f1')).equal(false);
  });

  it('should name no value anywhere: a hold takes only a name, origins and a time', () => {
    const pages = new SealedPages();
    pages.hold('f1', 'token', ['https://keys.example.test'], () => 1);

    should(JSON.stringify(pages.covering('f1', 'keys.example.test'))).not.containEql(SENTINEL);
  });

  it('should refuse everything that could show what a page says, and nothing that only acts', () => {
    for (const tool of [
      'browser.read',
      'browser.eval',
      'browser.console',
      'browser.network',
      'browser.screenshot',
      'browser.pdf',
      'browser.highlight',
      'browser.download',
      'browser.wait_for',
    ])
      should(SEALED_REFUSED_TOOLS.has(tool)).equal(true);
    for (const tool of ['browser.click', 'browser.type', 'browser.navigate', 'browser.fill_form', 'browser.scroll'])
      should(SEALED_REFUSED_TOOLS.has(tool)).equal(false);
  });

  it('should read a host out of an origin or an address, and nothing out of what is not one', () => {
    should(hostOfOrigin('https://Keys.Example.test:8443/x?y=1')).equal('keys.example.test:8443');
    should(hostOfOrigin('about:blank')).equal(undefined);
    should(hostOfOrigin('null')).equal(undefined);
    should(hostOfOrigin('')).equal(undefined);
  });
});

describe('what an agent is told when a page is closed', () => {
  const at = (epoch: number): string => new Date(epoch).toISOString();

  it('should say why, until when, what still works and how to end it sooner', () => {
    const sentence = sealedPageRefusal(
      'browser.read',
      '%browser:app',
      [{ copy: 'token', from: ['https://keys.example.test'], until: Date.UTC(2026, 10, 13, 12), own: true }],
      at,
    );

    should(sentence).containEql('browser.read is refused on %browser:app');
    should(sentence).containEql('sealed:token');
    should(sentence).containEql('https://keys.example.test');
    should(sentence).containEql('2026-11-13T12:00:00.000Z');
    should(sentence).containEql('click, type and navigate');
    should(sentence).containEql('secure_discard');
    should(sentence).containEql('person');
  });

  it('should end at the LAST of several copies and name them all', () => {
    const sentence = sealedPageRefusal(
      'browser.eval',
      '%browser:app',
      [
        { copy: 'a', from: ['https://x.test'], until: Date.UTC(2026, 10, 13, 10), own: true },
        { copy: 'b', from: ['https://x.test'], until: Date.UTC(2026, 10, 13, 14), own: true },
      ],
      at,
    );

    should(sentence).containEql('sealed:a, sealed:b');
    should(sentence).containEql('2026-11-13T14:00:00.000Z');
  });

  it('should word the capture and the picture refusals without a value', () => {
    should(capturePendingRefusal('browser.eval')).containEql('clipboard capture');
    const withheld = pictureWithheld('browser.screenshot', '%browser:other', ['token']);
    should(withheld).containEql('sealed:token');
    should(withheld).containEql('picture cannot be masked');
    should(withheld + capturePendingRefusal('browser.eval')).not.containEql(SENTINEL);
  });
});
