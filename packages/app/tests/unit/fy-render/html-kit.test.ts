/**
 * The theme kit an interactive `html` page gets: which app tokens cross into the opaque frame, the
 * one rule a value must pass, and the component stylesheet the guide teaches.
 *
 * What this tier cannot say: that a real frame stays transparent or that the classes look right —
 * that is the harness shots' job. What it proves is the contract the shell and the guide rely on.
 */
import { describe, test } from 'bun:test';
import should from 'should';
import {
  admitFyRenderHtmlToken,
  admittedFyRenderHtmlTokens,
  FY_RENDER_HTML_COMPONENT_CSS,
  FY_RENDER_HTML_KIT_CLASSES,
  FY_RENDER_HTML_KIT_CSS,
  FY_RENDER_HTML_TOKEN_MAX_LENGTH,
  FY_RENDER_HTML_TOKENS,
} from '../../../src/fy-render/html-kit.ts';
import { THEME_TOKENS } from '../../../src/fy-render/palette.ts';

describe('fy-render html kit tokens', () => {
  test('should carry every palette token an illustration reads, by its app name', () => {
    // Assert — the same `var(--fg)` a static fragment inherits works in a live page.
    for (const token of THEME_TOKENS) should(FY_RENDER_HTML_TOKENS).containEql(token);
    should(FY_RENDER_HTML_TOKENS).containEql('page-fg');
    should(FY_RENDER_HTML_TOKENS).containEql('page-font');
    should(new Set(FY_RENDER_HTML_TOKENS).size).equal(FY_RENDER_HTML_TOKENS.length);
  });

  test('should admit a listed token with a plain value', () => {
    // Assert — the shapes a computed token takes in each theme.
    should(admitFyRenderHtmlToken('fg', 'rgb(20, 20, 24)')).be.true();
    should(admitFyRenderHtmlToken('accent', 'color-mix(in srgb, #3b82f6 80%, transparent)')).be.true();
    should(admitFyRenderHtmlToken('font-body', "'Inter', ui-sans-serif, system-ui")).be.true();
    should(admitFyRenderHtmlToken('radius-sm', '6px')).be.true();
  });

  test('should refuse an unlisted name and any value that could name a resource or leave its declaration', () => {
    // Assert
    should(admitFyRenderHtmlToken('panel-texture', 'none')).be.false();
    should(admitFyRenderHtmlToken('__proto__', 'x')).be.false();
    for (const value of [
      'url(https://evil.test/x.png)',
      'image-set("a.png" 1x)',
      '\\75 rl(x)',
      'red; background: blue',
      'red}html{color:red',
      '<b>',
      '@import x',
      '',
      '   ',
      'x'.repeat(FY_RENDER_HTML_TOKEN_MAX_LENGTH + 1),
    ])
      should(admitFyRenderHtmlToken('bg', value)).be.false();
    should(admitFyRenderHtmlToken('bg', 42)).be.false();
  });

  test('should keep only the admitted tokens, in list order, from whatever a message carried', () => {
    // Act
    const admitted = admittedFyRenderHtmlTokens({
      accent: ' rgb(1, 2, 3) ',
      bg: 'url(x)',
      fg: 'rgb(4, 5, 6)',
      nope: 'red',
    });

    // Assert
    should(admitted).eql([
      ['fg', 'rgb(4, 5, 6)'],
      ['accent', 'rgb(1, 2, 3)'],
    ]);
    should(admittedFyRenderHtmlTokens(null)).eql([]);
    should(admittedFyRenderHtmlTokens('fg')).eql([]);
    should(admittedFyRenderHtmlTokens(Object.create({ fg: 'red' }))).eql([]);
  });
});

describe('fy-render html kit stylesheet', () => {
  test('should define every documented component class', () => {
    for (const name of FY_RENDER_HTML_KIT_CLASSES) {
      should(FY_RENDER_HTML_KIT_CSS).match(new RegExp(`\\.${name}(?![\\w-])`, 'u'));
      should(FY_RENDER_HTML_COMPONENT_CSS).match(new RegExp(`\\.${name}(?![\\w-])`, 'u'));
    }
  });

  test('should sit in a layer every author rule beats, and name no resource', () => {
    should(FY_RENDER_HTML_KIT_CSS.startsWith('@layer fy{')).be.true();
    should(FY_RENDER_HTML_COMPONENT_CSS.startsWith('@layer fy{')).be.true();
    should(FY_RENDER_HTML_KIT_CSS).not.match(/url\(|@import|https?:/iu);
    // Valid inside a `<style>` element: nothing that closes it.
    should(FY_RENDER_HTML_KIT_CSS).not.match(/<\//u);
  });

  test('should paint the page root transparent and never let it scroll inline', () => {
    should(FY_RENDER_HTML_KIT_CSS).match(/html\{background:transparent;/u);
    should(FY_RENDER_HTML_KIT_CSS).match(/html\{[^}]*overflow:hidden/u);
    should(FY_RENDER_HTML_KIT_CSS).match(/html\[data-fy-fullscreen\]\{overflow:auto\}/u);
    should(FY_RENDER_HTML_KIT_CSS).match(/body\{margin:0;max-width:100%/u);
  });

  test('should draw only in theme tokens, never a colour literal of its own', () => {
    // A colour literal in the kit would be a colour that does not follow the theme.
    should(FY_RENDER_HTML_KIT_CSS).not.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu);
    for (const name of ['--fg', '--accent', '--surface-2', '--border-strong', '--viz-1', '--viz-8', '--ok', '--err'])
      should(FY_RENDER_HTML_KIT_CSS).containEql(`var(${name}`);
  });

  test('should keep a visible focus ring on the range input', () => {
    should(FY_RENDER_HTML_KIT_CSS).match(/\.fy-range:focus-visible\{[^}]*outline:2px solid var\(--accent\)/u);
    should(FY_RENDER_HTML_KIT_CSS).not.match(/\.fy-range:focus-visible\{outline:none\}/u);
  });

  test('should tone a chip for every numeric data-tone 1–8', () => {
    for (let tone = 1; tone <= 8; tone += 1)
      should(FY_RENDER_HTML_KIT_CSS).containEql(`.fy-chip[data-tone="${tone}"]{`);
    should(FY_RENDER_HTML_KIT_CSS).containEql('.fy-chip[data-tone="good"]');
  });

  test('should leave a static fragment page-level rules out', () => {
    should(FY_RENDER_HTML_COMPONENT_CSS).not.match(/(^|\})html\{/u);
    should(FY_RENDER_HTML_COMPONENT_CSS).not.match(/(^|\})body\{/u);
  });
});
