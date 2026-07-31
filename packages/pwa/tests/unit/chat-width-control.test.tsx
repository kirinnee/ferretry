import { describe, expect, it } from 'bun:test';
import type { ReactTestInstance } from 'react-test-renderer';
import { CHAT_WIDTH_OPTIONS, type ChatWidth, ChatWidthControl } from '../../src/shell/chat-width-control.tsx';
import { render } from '../support/react.ts';

const radiosOf = (root: ReactTestInstance): ReactTestInstance[] =>
  root.findAllByType('input').filter(input => input.props.type === 'radio');

const cardsOf = (root: ReactTestInstance): ReactTestInstance[] => root.findAllByType('label');

const previewOf = (root: ReactTestInstance): ReactTestInstance =>
  root.findAll(node => node.props['data-chat-width-preview'] !== undefined)[0] as ReactTestInstance;

describe('ChatWidthControl', () => {
  it('offers the three modes as one named, described group of native radios', () => {
    const root = render(<ChatWidthControl value="full" onChange={() => {}} />).root;
    const group = root.findByType('fieldset');

    expect(group.props['aria-describedby']).toBeTruthy();
    expect(root.findByType('legend').props.children).toBe('Conversation width');
    expect(radiosOf(root)).toHaveLength(3);
    expect(radiosOf(root).every(radio => radio.props.name === 'chat-width')).toBe(true);
    expect(CHAT_WIDTH_OPTIONS.map(option => option.id)).toEqual(['full', 'balanced', 'readable']);
  });

  it('checks exactly the mode in force, and dresses the same card as selected', () => {
    for (const value of ['full', 'balanced', 'readable'] as const) {
      const root = render(<ChatWidthControl value={value} onChange={() => {}} />).root;
      const expected = CHAT_WIDTH_OPTIONS.map(option => option.id === value);

      expect(radiosOf(root).map(radio => radio.props.checked)).toEqual(expected);
      expect(cardsOf(root).map(card => card.props.className.includes('border-accent bg-accent-soft'))).toEqual(
        expected,
      );
    }
  });

  it('reports the mode a reader picks', () => {
    const chosen: ChatWidth[] = [];
    const radios = radiosOf(render(<ChatWidthControl value="full" onChange={value => chosen.push(value)} />).root);

    radios[1]?.props.onChange();
    radios[2]?.props.onChange();

    expect(chosen).toEqual(['balanced', 'readable']);
  });

  it('keeps the touch floor on every option, so a phone can hit them', () => {
    for (const card of cardsOf(render(<ChatWidthControl value="full" onChange={() => {}} />).root)) {
      expect(card.props.className).toContain('min-h-[44px]');
    }
  });

  it('draws a focus ring on the card, because the radio itself is visually hidden', () => {
    const [card] = cardsOf(render(<ChatWidthControl value="full" onChange={() => {}} />).root);

    expect(card?.props.className).toContain('has-[:focus-visible]:ring-2');
    expect(radiosOf(render(<ChatWidthControl value="full" onChange={() => {}} />).root)[0]?.props.className).toBe(
      'sr-only',
    );
  });

  it('moves the preview even when the conversation itself cannot', () => {
    expect(previewOf(render(<ChatWidthControl value="full" onChange={() => {}} />).root).props.className).toContain(
      'w-full',
    );
    expect(previewOf(render(<ChatWidthControl value="balanced" onChange={() => {}} />).root).props.className).toContain(
      'w-5/6 max-w-[220px]',
    );
    expect(previewOf(render(<ChatWidthControl value="readable" onChange={() => {}} />).root).props.className).toContain(
      'w-2/3 max-w-[180px]',
    );
  });

  it('labels the preview with the cap the mode actually applies', () => {
    const labels = (['full', 'balanced', 'readable'] as const).map(value => {
      const spans = render(<ChatWidthControl value={value} onChange={() => {}} />).root.findAllByType('span');
      return spans.map(span => span.props.children).find(child => typeof child === 'string' && child.includes('·'));
    });

    expect(labels).toEqual(['Full-bleed · default', 'Balanced · 900px max', 'Readable · 768px max']);
  });

  it('names the mode in force politely, and admits the three look the same when narrow', () => {
    const root = render(<ChatWidthControl value="readable" onChange={() => {}} />).root;
    const paragraph = root.findByType('p');

    expect(paragraph.props['aria-live']).toBe('polite');
    expect(paragraph.props.id).toBe(root.findByType('fieldset').props['aria-describedby']);
    expect(String(paragraph.props.children[0])).toContain('Readable column is active');
    expect(String(paragraph.props.children[1])).toContain('768px wide or narrower');
  });

  it('hides the decorative preview from assistive tech', () => {
    const root = render(<ChatWidthControl value="full" onChange={() => {}} />).root;

    expect(root.findAll(node => node.props['aria-hidden'] === 'true')).not.toHaveLength(0);
  });
});
