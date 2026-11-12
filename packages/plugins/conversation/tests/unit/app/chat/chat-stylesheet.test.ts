import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE CHAT'S OWN RULES REACH THE PAGE. The transcript, its rows, the Jump pill's row and the composer were drawn
 * with no stylesheet of their own: today's `session-screens.css` was not carried into the half, so `.fy-transcript`
 * was not a scroller. A real browser then showed the whole conversation at once, asked for older pages on load,
 * never offered the Jump pill, left a band of nothing above the composer on a desktop, and drew a send's "⋯" button
 * at 44px with no hit area (the chat visual suites). The rules are `app/chat/chat.css`, which the half's stylesheet
 * list names so the shell loads it through `generated/plugin-styles.css`.
 */

/** This plugin's app half. */
const APP = join(import.meta.dir, '../../../../app');
const read = (path: string): string => readFileSync(join(APP, path), 'utf8');
const rule = (css: string, selector: string): string =>
  css.match(new RegExp(`\\n${selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} \\{[^}]*\\}`, 'u'))?.[0] ?? '';

describe("the chat's own stylesheet", () => {
  const css = read('chat/chat.css');

  it('is in the half’s stylesheet list, ahead of the rows that build on it', () => {
    const list = read('styles.css');
    const imports = [...list.matchAll(/@import '([^']+)';/gu)].map(match => match[1]);
    expect(imports).toContain('./chat/chat.css');
    expect(imports.indexOf('./chat/chat.css')).toBeLessThan(imports.indexOf('./chat/compaction-card.css'));
  });

  it('makes the transcript the scroller, so the reader can leave the tail and come back', () => {
    const scroller = rule(css, '.fy-transcript');
    expect(scroller).toContain('overflow-y: auto;');
    expect(scroller).toContain('min-height: 0;');
    expect(rule(css, '.fy-transcript-shell')).toContain('flex-direction: column;');
  });

  it("draws the Jump pill's own row and the top of the history", () => {
    expect(rule(css, '.fy-jump-latest-shell')).toContain('display: flex;');
    expect(rule(css, '.fy-transcript-history')).toContain('min-height: 40px;');
  });

  it('keeps a send’s actions button 28px to look at and 44px to hit', () => {
    expect(rule(css, '.fy-receipt-line .fy-ledger-more')).toContain('height: 28px;');
    const hit = rule(css, '.fy-receipt-line .fy-ledger-more::after');
    expect(hit).toContain('height: 44px;');
    expect(hit).toContain('width: 44px;');
  });

  it('styles the composer row and a peer’s foot link', () => {
    expect(rule(css, '.fy-composer-row')).toContain('display: flex;');
    expect(rule(css, '.fy-peer-open')).toContain('text-overflow: ellipsis;');
  });

  it('draws the update’s “check the chat” note at the normal badge size, in warn text on the warn tint that is AA in every themed swatch', () => {
    const note = rule(css, '.fy-receipt-note');
    expect(note).toContain('font-size: var(--text-sm);');
    expect(note).toContain('color: var(--warn);');
    expect(note).toContain('background: var(--warn-bg);');
    const themes = readFileSync(join(import.meta.dir, '../../../../../../app/src/styles/themes.css'), 'utf8');
    const linear = (channel: number): number => {
      const unit = channel / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string): number => {
      const value = Number.parseInt(hex.slice(1), 16);
      return 0.2126 * linear((value >> 16) & 255) + 0.7152 * linear((value >> 8) & 255) + 0.0722 * linear(value & 255);
    };
    const checked: string[] = [];
    for (const block of themes.matchAll(/\n(\[data-swatch[^{]*)\{([^}]*)\}/gu)) {
      const warn = block[2]?.match(/--warn:\s*(#[0-9a-fA-F]{6});/u)?.[1];
      const tint = block[2]?.match(/--warn-bg:\s*(#[0-9a-fA-F]{6});/u)?.[1];
      if (warn === undefined || tint === undefined) continue; // a tint mixed from the surface is not a fixed pair
      const [light, dark] = [luminance(warn), luminance(tint)].sort((a, b) => b - a) as [number, number];
      expect((light + 0.05) / (dark + 0.05)).toBeGreaterThanOrEqual(4.5);
      checked.push(block[1]?.trim() ?? '');
    }
    expect(checked.length).toBeGreaterThanOrEqual(8);
  });

  it('leaves the rules other homes own to them', () => {
    for (const foreign of ['.fy-question-form', '.fy-remote-browser', '.fy-chat-search', '.fy-convo-row'])
      expect(css).not.toContain(foreign);
  });
});
