import { describe, expect, test } from 'bun:test';
import { CacheUpdating } from '../../src/components/cache-updating.tsx';
import '../support/dom.ts';
import { render, run } from '../support/react.ts';

describe('CacheUpdating', () => {
  test('says "Updating…" as a polite status marked for the host to find', () => {
    // Arrange
    const subject = render(<CacheUpdating />);

    // Act
    const pill = subject.root.findByProps({ 'data-cache-updating': '' });

    // Assert
    expect(pill.props.role).toBe('status');
    expect(pill.props['aria-live']).toBe('polite');
    expect(pill.props.className.endsWith('shadow-panel')).toBe(true);
    run(() => subject.unmount());
  });

  test.each([
    { input: undefined, expected: false },
    { input: 'absolute left-1/2', expected: true },
  ])('appends the host placement only when it gives one ($input)', ({ input, expected }) => {
    // Arrange
    const subject = render(input === undefined ? <CacheUpdating /> : <CacheUpdating className={input} />);

    // Act
    const actual = subject.root.findByProps({ 'data-cache-updating': '' }).props.className as string;

    // Assert
    expect(actual.endsWith(` ${input}`)).toBe(expected);
    run(() => subject.unmount());
  });
});
