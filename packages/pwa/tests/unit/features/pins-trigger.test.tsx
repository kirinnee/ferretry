import { describe, expect, it } from 'bun:test';

import { PinsTrigger, pinsTriggerLabel } from '../../../src/features/pins/pins-trigger.tsx';
import { render, run } from '../../support/react.ts';

describe('PinsTrigger', () => {
  it('names an empty ledger plainly and does not claim a controlled surface is open', () => {
    const renderer = render(
      <PinsTrigger id="pins" count={0} expanded={false} onClick={() => undefined} controls="pins-sheet" />,
    );
    const button = renderer.root.findByType('button');

    expect(pinsTriggerLabel(0)).toBe('Pins');
    expect(button.props['aria-label']).toBe('Pins');
    expect(button.props['aria-controls']).toBeUndefined();
    expect(button.props.className).toContain('h-[44px]');
  });

  it('shows the exact count, exposes the controlled sheet, and returns its opener to the host', () => {
    const openers: unknown[] = [];
    const renderer = render(
      <PinsTrigger id="pins" count={12} expanded onClick={opener => openers.push(opener)} controls="pins-sheet" />,
    );
    const button = renderer.root.findByType('button');

    expect(pinsTriggerLabel(12)).toBe('Pins (12)');
    expect(button.props['aria-controls']).toBe('pins-sheet');
    expect(JSON.stringify(renderer.toJSON())).toContain('12');
    run(() => button.props.onClick({ currentTarget: 'opener' }));
    expect(openers).toEqual(['opener']);
  });

  it('caps only the visual badge while keeping the full accessible count', () => {
    const renderer = render(<PinsTrigger id="pins" count={100} expanded={false} onClick={() => undefined} />);

    expect(pinsTriggerLabel(100)).toBe('Pins (100)');
    expect(renderer.root.findByType('button').props.title).toBe('Pins (100)');
    expect(JSON.stringify(renderer.toJSON())).toContain('99+');
  });
});
