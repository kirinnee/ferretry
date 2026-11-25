import { describe, it } from 'bun:test';
import should from 'should';
import { ago, clip, oneLine, tailText } from '../../../daemon/lib/mcp/format.ts';
import { SlidingWindowLimiter } from '../../../daemon/lib/mcp/rate-limit.ts';
import { parseAttentionRef } from '../../../daemon/lib/mcp/tools/index.ts';

describe('ago', () => {
  const now = Date.parse('2026-11-24T12:00:00.000Z');
  const at = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  it('speaks plainly', () => {
    should(ago(now, at(10))).equal('just now');
    should(ago(now, at(300))).equal('5 min ago');
    should(ago(now, at(3 * 3600))).equal('3 h ago');
    should(ago(now, at(3 * 86400))).equal('3 days ago');
    should(ago(now, undefined)).equal('unknown');
    should(ago(now, 'garbage')).equal('unknown');
  });
});

describe('tailText', () => {
  it('keeps the last lines, then the last characters, and says when it cut', () => {
    const text = Array.from({ length: 10 }, (_, n) => `l${n}`).join('\n');
    should(tailText(text, 3, 1000)).eql({ text: 'l7\nl8\nl9', linesShown: 3, truncated: true });
    should(tailText(text, 50, 1000).truncated).be.false();
    const cut = tailText(`${'a'.repeat(50)}\n${'b'.repeat(50)}`, 10, 60);
    should(cut.truncated).be.true();
    should(cut.text.endsWith('b'.repeat(50))).be.true();
    should(cut.text.length).be.belowOrEqual(60);
  });
});

describe('clip / oneLine', () => {
  it('clips with an ellipsis within the bound and folds whitespace', () => {
    should(clip('abcdef', 4)).equal('abc…');
    should(clip('abc', 4)).equal('abc');
    should(oneLine('a\n  b\t c')).equal('a b c');
  });
});

describe('SlidingWindowLimiter', () => {
  it('allows `limit` hits per window, reports Retry-After, and counts nothing when over', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(() => now);
    for (let n = 0; n < 3; n += 1) should(limiter.take('k', 3).ok).be.true();
    const over = limiter.take('k', 3);
    should(over.ok).be.false();
    if (!over.ok) should(over.retryAfterSeconds).equal(60);
    now = 59_000;
    should(limiter.peek('k', 3).ok).be.false();
    now = 60_001;
    should(limiter.take('k', 3).ok).be.true();
  });
});

describe('parseAttentionRef', () => {
  it('accepts the spoken spellings of an item id and nothing else', () => {
    for (const ref of ['A12', '!A12', 'a12', '12', ' ! a 12 ', 'A012']) should(parseAttentionRef(ref)).equal('A12');
    for (const ref of ['', 'A', 'B12', '12x', 'A-1', '0']) should(parseAttentionRef(ref)).be.undefined();
  });
});

describe('SlidingWindowLimiter — forgetting idle keys', () => {
  it('drops the keys whose hits have all left the window once many keys pile up', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(() => now);
    for (let n = 0; n < 300; n += 1) should(limiter.take(`grant-${n}`, 1).ok).be.true();
    now = 61_000;
    // One more hit sweeps the 300 idle keys; the key that is still live keeps its count.
    should(limiter.take('fresh', 1).ok).be.true();
    should(limiter.take('fresh', 1).ok).be.false();
    should(limiter.take('grant-0', 1).ok).be.true();
  });
});
