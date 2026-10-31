import { describe, it } from 'bun:test';
import should from 'should';
import { BrowserActionSchema } from '../../src/lib/browser.ts';
import * as pointer from '../../src/lib/browser-pointer.ts';
import { AgentToolCallSchema } from '../../src/lib/agent-tools.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const cases: SchemaCase[] = [
  { name: 'key chord', schema: pointer.BrowserKeyChordSchema, value: 'Control+Shift+K' },
  { name: 'press keys', schema: pointer.BrowserPressKeysSchema, value: ['Enter', 'ArrowDown'] },
  { name: 'select values', schema: pointer.BrowserSelectValuesSchema, value: ['uk', 'United States'] },
  { name: 'mouse action', schema: pointer.BrowserMouseActionSchema, value: 'wheel' },
  { name: 'scroll delta', schema: pointer.BrowserScrollDeltaSchema, value: -20_000 },
  { name: 'scroll pages', schema: pointer.BrowserScrollPagesSchema, value: 0.5 },
  { name: 'drag steps', schema: pointer.BrowserDragStepsSchema, value: 100 },
];

const tool = (value: Record<string, unknown>): SchemaCase => ({
  name: JSON.stringify(value).slice(0, 70),
  schema: AgentToolCallSchema,
  value: { name: 'app', ...value },
});
const accepts = (value: Record<string, unknown>): boolean =>
  AgentToolCallSchema.safeParse({ name: 'app', ...value }).success;

describe('browser pointer and keys vocabulary', () => {
  it('should round-trip every public pointer schema', () => {
    assertRoundTrips(cases);
    assertCoversEverySchema(pointer, cases);
  });

  it('should take a key as modifiers and then one named key or one character, and nothing else', () => {
    // Arrange
    const good = [
      'Enter',
      'a',
      'Z',
      '€',
      'Control+Shift+K',
      'ControlOrMeta+a',
      'Alt+F4',
      'Shift+Tab',
      'Control++',
      '+',
      'Shift',
    ];
    const bad = [
      '',
      'ab',
      'Ctrl+a',
      'control+a',
      'Control+Control+a',
      'Control+',
      'Control+Enter+a',
      'Enter+Control',
      '\n',
      'x'.repeat(41),
    ];

    // Act
    const parsed = good.map(chord => pointer.parseBrowserKeyChord(chord));

    // Assert
    should(parsed.every(chord => chord !== undefined)).be.true();
    should(bad.map(chord => pointer.parseBrowserKeyChord(chord))).deepEqual(bad.map(() => undefined));
    should(pointer.parseBrowserKeyChord('Control+Shift+K')).deepEqual({ modifiers: ['Control', 'Shift'], key: 'K' });
    should(pointer.parseBrowserKeyChord('Control++')).deepEqual({ modifiers: ['Control'], key: '+' });
  });

  it('should accept every pointer tool in its forms', () => {
    should(
      [
        { tool: 'browser.hover', selector: '#menu' },
        { tool: 'browser.hover', x: 10, y: 20 },
        { tool: 'browser.drag', fromRef: 'e2', toSelector: '#bin' },
        { tool: 'browser.drag', fromX: 1, fromY: 2, toX: 300, toY: 2, steps: 40 },
        { tool: 'browser.mouse', action: 'move', x: 5, y: 6 },
        { tool: 'browser.mouse', action: 'down', button: 'right' },
        { tool: 'browser.mouse', action: 'up' },
        { tool: 'browser.mouse', action: 'wheel', deltaY: 600 },
        { tool: 'browser.mouse', action: 'wheel', x: 4, y: 4, deltaX: -20, deltaY: 20_000 },
        { tool: 'browser.press', keys: ['Control+Shift+K'], ref: 'e4' },
        { tool: 'browser.scroll', ref: 'e9' },
        { tool: 'browser.scroll', text: 'Terms' },
        { tool: 'browser.scroll', deltaY: -300 },
        { tool: 'browser.scroll', pages: -20 },
        { tool: 'browser.select', selector: 'select', values: ['a'] },
        { tool: 'browser.check', ref: 'e1', checked: false },
        {
          tool: 'browser.fill_form',
          fields: [
            { ref: 'e1', text: 'a' },
            { selector: '#t', checked: false },
            { ref: 'e2', option: 'uk' },
            { ref: 'e3', value: '2026-01-01' },
          ],
        },
        { tool: 'browser.highlight', ref: 'e1' },
        { tool: 'browser.highlight', clear: true },
      ].map(accepts),
    ).deepEqual(Array.from({ length: 19 }, () => true));
  });

  it('should refuse a pointer tool that names no target, two, or mixes an element with a point', () => {
    assertRejects([
      tool({ tool: 'browser.hover' }),
      tool({ tool: 'browser.hover', ref: 'e1', selector: 'a' }),
      tool({ tool: 'browser.drag', fromRef: 'e2' }),
      tool({ tool: 'browser.drag', fromRef: 'e2', toX: 1, toY: 2 }),
      tool({ tool: 'browser.drag', fromRef: 'e2', fromSelector: 'a', toRef: 'e3' }),
      tool({ tool: 'browser.drag', fromRef: 'e2', toRef: 'e3', steps: 5 }),
      tool({ tool: 'browser.drag', fromX: 1, fromY: 2, toX: 3, toY: 4, steps: 101 }),
      tool({ tool: 'browser.drag', fromX: 1, fromY: 2, toX: 3, toY: 4, steps: 0 }),
      tool({ tool: 'browser.mouse', action: 'move' }),
      tool({ tool: 'browser.mouse', action: 'move', x: 1 }),
      tool({ tool: 'browser.mouse', action: 'wheel' }),
      tool({ tool: 'browser.mouse', action: 'wheel', deltaY: 20_001 }),
      tool({ tool: 'browser.mouse', action: 'down', deltaY: 1 }),
      tool({ tool: 'browser.mouse', action: 'move', x: 1, y: 2, button: 'left' }),
      tool({ tool: 'browser.mouse', action: 'drag', x: 1, y: 2 }),
      tool({ tool: 'browser.press', keys: [] }),
      tool({ tool: 'browser.press', keys: ['Ctrl+a'] }),
      tool({ tool: 'browser.press', keys: Array.from({ length: 33 }, () => 'a') }),
      tool({ tool: 'browser.press', keys: ['a'], x: 1, y: 2 }),
      tool({ tool: 'browser.scroll' }),
      tool({ tool: 'browser.scroll', ref: 'e1', pages: 1 }),
      tool({ tool: 'browser.scroll', text: 'a', deltaY: 1 }),
      tool({ tool: 'browser.scroll', pages: 21 }),
      tool({ tool: 'browser.scroll', deltaX: -20_001 }),
      tool({ tool: 'browser.select', ref: 'e1', values: [] }),
      tool({ tool: 'browser.select', ref: 'e1', values: Array.from({ length: 65 }, () => 'a') }),
      tool({ tool: 'browser.select', values: ['a'] }),
      tool({ tool: 'browser.check', ref: 'e1' }),
      tool({ tool: 'browser.check', checked: true }),
      tool({ tool: 'browser.fill_form', fields: [] }),
      tool({ tool: 'browser.fill_form', fields: Array.from({ length: 33 }, () => ({ ref: 'e1', text: 'a' })) }),
      tool({ tool: 'browser.fill_form', fields: [{ ref: 'e1' }] }),
      tool({ tool: 'browser.fill_form', fields: [{ ref: 'e1', text: 'a', checked: true }] }),
      tool({ tool: 'browser.fill_form', fields: [{ text: 'a' }] }),
      tool({ tool: 'browser.fill_form', fields: [{ ref: 'e1', text: 'a', extra: 1 }] }),
      tool({
        tool: 'browser.fill_form',
        fields: Array.from({ length: 5 }, () => ({ ref: 'e1', text: 'a'.repeat(16_384) })),
      }),
      tool({ tool: 'browser.highlight' }),
      tool({ tool: 'browser.highlight', ref: 'e1', clear: true }),
      tool({ tool: 'browser.highlight', clear: false }),
    ]);
  });

  it('should carry the same grammar on the browser action, with the mouse action under its own name', () => {
    should(BrowserActionSchema.safeParse({ action: 'hover', ref: 'e1' }).success).be.true();
    should(BrowserActionSchema.safeParse({ action: 'drag', fromX: 1, fromY: 2, toX: 3, toY: 4 }).success).be.true();
    should(BrowserActionSchema.safeParse({ action: 'mouse', mouseAction: 'wheel', deltaY: 3 }).success).be.true();
    should(BrowserActionSchema.safeParse({ action: 'press', keys: ['Enter'] }).success).be.true();
    should(
      BrowserActionSchema.safeParse({ action: 'fill-form', fields: [{ ref: 'e1', text: 'a' }] }).success,
    ).be.true();
    should(BrowserActionSchema.safeParse({ action: 'mouse', mouseAction: 'move' }).success).be.false();
    should(BrowserActionSchema.safeParse({ action: 'press', keys: ['Ctrl+a'] }).success).be.false();
    should(BrowserActionSchema.safeParse({ action: 'highlight' }).success).be.false();
  });
});
