import { describe, it } from 'bun:test';
import should from 'should';
import { browsersLoosens } from '../../contract/config-loosens.ts';
import { BrowsersConfigSchema } from '../../contract/index.ts';
import { chromiumEngine, engineFor } from '../../daemon/worker/engine.ts';

const proxy = (url: string) => ({ url, bypass: [] as string[] });

describe('identity settings in browsers.yaml', () => {
  it('should accept an engine, a proxy and maxRunning, and refuse the ones that mean nothing', () => {
    // Act
    const parsed = BrowsersConfigSchema.parse({
      engine: 'chromium',
      maxRunning: 2,
      identities: { work: { engine: 'chromium', proxy: proxy('http://proxy.example:8080') } },
    });

    // Assert
    should(parsed.maxRunning).equal(2);
    should(parsed.identities?.work?.proxy?.url).equal('http://proxy.example:8080');
    should(BrowsersConfigSchema.safeParse({ engine: 'cloak' }).success).be.false();
    should(BrowsersConfigSchema.safeParse({ identities: { work: { engine: 'firefox' } } }).success).be.false();
    should(BrowsersConfigSchema.safeParse({ maxRunning: 0 }).success).be.false();
    should(BrowsersConfigSchema.safeParse({ maxRunning: 17 }).success).be.false();
    should(BrowsersConfigSchema.safeParse({ identities: { 'Work/..': {} } }).success).be.false();
  });

  it('should hold a newly set or changed identity proxy for the owner, and nothing else about it', () => {
    // Arrange
    const base = BrowsersConfigSchema.parse({ identities: { work: {} } });
    const withProxy = BrowsersConfigSchema.parse({ identities: { work: { proxy: proxy('http://a.example:1') } } });
    const moved = BrowsersConfigSchema.parse({ identities: { work: { proxy: proxy('http://b.example:1') } } });

    // Act / Assert — a proxy the identity did not have, or now points elsewhere, loosens; dropping it or editing nothing does not.
    should(browsersLoosens(base, withProxy)).have.length(1);
    should(browsersLoosens(base, withProxy)[0]).match(/work browser identity.*http:\/\/a\.example:1/u);
    should(browsersLoosens(withProxy, moved)).have.length(1);
    should(browsersLoosens(withProxy, withProxy)).deepEqual([]);
    should(browsersLoosens(withProxy, base)).deepEqual([]);
    should(browsersLoosens(base, BrowsersConfigSchema.parse({ maxRunning: 8, engine: 'chromium' }))).deepEqual([]);
  });
});

describe('the engine seam', () => {
  it('should resolve chromium, the only engine, by default and by name', () => {
    should(engineFor()).equal(chromiumEngine);
    should(engineFor('chromium').id).equal('chromium');
  });
});
