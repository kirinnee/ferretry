import { describe, expect, it } from 'bun:test';
import type { ReactTestInstance } from 'react-test-renderer';
import { OpenLinksInSetting } from '../../../../src/features/settings/conversation-settings.tsx';
import type { OpenLinksIn } from '../../../../src/lib/controls.ts';
import { render, run } from '../../../support/react.ts';

const text = (node: ReactTestInstance): string =>
  node.children.map(child => (typeof child === 'string' ? child : text(child))).join('');

const radios = (root: ReactTestInstance) =>
  root.findAll(node => node.type === 'input' && node.props.name === 'appearance-open-links-in');

const COMPUTER = 'Your computer’s default browser';

describe('OpenLinksInSetting', () => {
  it('offers two choices when no daemon on this computer is connected', () => {
    const view = render(<OpenLinksInSetting openLinksIn="browser" onChange={() => undefined} />);

    expect(radios(view.root).map(radio => radio.props.value)).toEqual(['browser', 'panel']);
    expect(text(view.root)).not.toContain('default browser');
    run(() => view.unmount());
  });

  it('offers the computer’s default browser as a third choice, and saves it, when one is connected', () => {
    const chosen: OpenLinksIn[] = [];
    const view = render(<OpenLinksInSetting computerAvailable openLinksIn="browser" onChange={v => chosen.push(v)} />);

    expect(radios(view.root).map(radio => radio.props.value)).toEqual(['browser', 'panel', 'computer']);
    expect(text(view.root)).toContain(COMPUTER.replace('’', "'"));
    run(() => radios(view.root)[2]?.props.onChange());
    expect(chosen).toEqual(['computer']);
    run(() => view.unmount());
  });

  it('shows the browser as selected when the computer was chosen but no local daemon is connected', () => {
    const view = render(<OpenLinksInSetting openLinksIn="computer" onChange={() => undefined} />);

    expect(radios(view.root).map(radio => [radio.props.value, radio.props.checked])).toEqual([
      ['browser', true],
      ['panel', false],
    ]);
    run(() => view.unmount());
  });

  it('shows the computer as selected when it was chosen and a local daemon is connected', () => {
    const view = render(<OpenLinksInSetting computerAvailable openLinksIn="computer" onChange={() => undefined} />);

    expect(radios(view.root).map(radio => [radio.props.value, radio.props.checked])).toEqual([
      ['browser', false],
      ['panel', false],
      ['computer', true],
    ]);
    run(() => view.unmount());
  });
});
