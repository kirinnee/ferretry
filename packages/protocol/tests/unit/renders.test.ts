import { describe, it } from 'bun:test';
import should from 'should';
import { renderSaveRefusal } from '../../src/lib/render-save.ts';
import {
  RENDER_MAX_BODY_BYTES,
  RENDER_PAYLOAD_BYTES,
  RenderIdSchema,
  RenderSaveRequestSchema,
  renderToken,
} from '../../src/lib/renders.ts';
import { FY_RENDER_LIMITS } from '../../src/lib/fy-render-caps.ts';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

describe('RenderIdSchema', () => {
  it('should take six to fifty-two lowercase Crockford base32 characters and nothing else', () => {
    for (const id of ['7k2m9q', 'abcdef', 'a'.repeat(52), '234567', '0123456789abcdefghjkmnpqrstvwxyz'])
      should(RenderIdSchema.safeParse(id).success).be.true();
    for (const id of [
      '',
      'abcde',
      'a'.repeat(53),
      'ABCDEF',
      'abcdei',
      'abcdel',
      'abcdeo',
      'abcdeu',
      'abc-de',
      '../abc',
      'abc def',
    ])
      should(RenderIdSchema.safeParse(id).success).be.false();
  });
});

describe('renderToken', () => {
  it('should spell a token the way a ferret pastes it', () => {
    should(renderToken('svg', '7k2m9q')).equal('%svg:7k2m9q');
    should(renderToken('html', 'abcdef')).equal('%html:abcdef');
  });
});

describe('the caps', () => {
  it('should read the payload caps from the fy-render owner and bound the body by the worst escaping', () => {
    should(RENDER_PAYLOAD_BYTES).deepEqual({ svg: FY_RENDER_LIMITS.svgBytes, html: FY_RENDER_LIMITS.htmlBytes });
    should(RENDER_MAX_BODY_BYTES).be.above(FY_RENDER_LIMITS.htmlBytes * 6);
  });
});

describe('RenderSaveRequestSchema', () => {
  it('should take the two stored kinds and refuse any other type and any unknown field', () => {
    should(RenderSaveRequestSchema.safeParse({ kind: 'svg', alt: 'a', payload: SVG }).success).be.true();
    should(
      RenderSaveRequestSchema.safeParse({ kind: 'html', alt: 'a', payload: 'x', supersedes: 'abcdef' }).success,
    ).be.true();
    for (const bad of [
      { kind: 'mermaid', alt: 'a', payload: 'x' },
      { kind: 'svg', alt: 'a', payload: 'x', extra: true },
      { kind: 'svg', alt: 'a', payload: 'x', supersedes: 'NOPE' },
      { kind: 'svg', alt: 'a' },
    ])
      should(RenderSaveRequestSchema.safeParse(bad).success).be.false();
  });
});

describe('renderSaveRefusal', () => {
  it('should accept a valid svg and a valid html fragment', () => {
    should(renderSaveRefusal({ kind: 'svg', alt: 'A circle', payload: SVG })).be.null();
    should(renderSaveRefusal({ kind: 'html', alt: 'A page', payload: '<h1>Hi</h1>' })).be.null();
  });

  it('should refuse what the reader would refuse, with the reader’s own words', () => {
    should(renderSaveRefusal({ kind: 'svg', alt: 'x', payload: '<div/>' })).match(/must begin with an <svg>/u);
    should(renderSaveRefusal({ kind: 'svg', alt: 'x', payload: '<svg viewBox="0 0 1 1"><script/></svg>' })).match(
      /script/u,
    );
    should(
      renderSaveRefusal({ kind: 'svg', alt: 'x', payload: `<svg viewBox="0 0 1 1">${'a'.repeat(101 * 1024)}</svg>` }),
    ).match(/100 KiB/u);
    should(renderSaveRefusal({ kind: 'html', alt: 'x', payload: 'a'.repeat(201 * 1024) })).match(/200 KiB/u);
  });

  it('should refuse a bad alt the way the fence does', () => {
    should(renderSaveRefusal({ kind: 'html', alt: '', payload: 'x' })).match(/Alt text must not be empty/u);
    should(renderSaveRefusal({ kind: 'html', alt: 'a'.repeat(201), payload: 'x' })).match(/200 characters/u);
    should(renderSaveRefusal({ kind: 'html', alt: 'one\ntwo', payload: 'x' })).match(/one line/u);
    should(renderSaveRefusal({ kind: 'html', alt: 'tab\there', payload: 'x' })).match(/one line/u);
  });

  it('should refuse an empty payload and an unpaired surrogate in either field', () => {
    should(renderSaveRefusal({ kind: 'html', alt: 'x', payload: ' \n ' })).match(/must not be empty/u);
    should(renderSaveRefusal({ kind: 'html', alt: 'x', payload: 'a\ud800b' })).match(/surrogate/u);
    should(renderSaveRefusal({ kind: 'html', alt: 'a\udc00', payload: 'x' })).match(/surrogate/u);
  });
});
