import { describe, expect, test } from 'bun:test';
import { Spinner } from '../../src/components/spinner.tsx';
import '../support/dom.ts';
import { render, run } from '../support/react.ts';

describe('Spinner', () => {
  test('is one decorative mark: an arc on a visible track, hidden from assistive technology', () => {
    const view = render(<Spinner />);
    const mark = view.root.findByProps({ 'data-spinner': '' });
    expect(mark.props['aria-hidden']).toBe('true');
    expect(mark.props.className).toBe('fy-spinner');
    expect(mark.props.width).toBe(14);
    expect(view.root.findAllByProps({ className: 'fy-spinner-track' })).toHaveLength(1);
    expect(view.root.findAllByProps({ className: 'fy-spinner-arc' })).toHaveLength(1);
    run(() => view.unmount());
  });

  test('takes a size and an extra class for a surface that needs its own contrast', () => {
    const view = render(<Spinner className="fy-spinner--on-accent" size={18} />);
    const mark = view.root.findByProps({ 'data-spinner': '' });
    expect(mark.props.className).toBe('fy-spinner fy-spinner--on-accent');
    expect(mark.props.width).toBe(18);
    expect(mark.props.height).toBe(18);
    run(() => view.unmount());
  });
});
