import { describe, expect, it } from 'bun:test';
import { lateBound } from '../../../src/lib/runtime/modules.ts';

describe('lateBound', () => {
  it('should answer undefined until the composition root binds it', () => {
    // Arrange
    const link = lateBound<string>();

    // Act
    const early = link.current();

    // Assert
    expect(early).toBeUndefined();
  });

  it('should answer the bound value from then on', () => {
    // Arrange
    const link = lateBound<{ readonly name: string }>();
    const value = { name: 'agenda' };

    // Act
    link.bind(value);

    // Assert
    expect(link.current()).toBe(value);
    expect(link.current()).toBe(value);
  });

  it('should refuse a second bind and keep the first value', () => {
    // Arrange
    const link = lateBound<string>();
    link.bind('first');

    // Act
    const second = (): void => link.bind('second');

    // Assert
    expect(second).toThrow('already bound');
    expect(link.current()).toBe('first');
  });

  it('should keep two links independent', () => {
    // Arrange
    const first = lateBound<number>();
    const second = lateBound<number>();

    // Act
    first.bind(1);

    // Assert
    expect(first.current()).toBe(1);
    expect(second.current()).toBeUndefined();
  });
});
