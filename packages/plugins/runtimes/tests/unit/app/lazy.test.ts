import { describe, expect, it } from 'bun:test';
import { lazyComponent } from '../../../app/lazy.ts';

const suspended = (call: () => unknown): Promise<unknown> => {
  try {
    call();
  } catch (thrown) {
    if (thrown instanceof Promise) return thrown;
    throw thrown;
  }
  throw new Error('expected the component to suspend');
};

describe('lazyComponent', () => {
  it('suspends on the first call, loads once, then renders the real component with the props', async () => {
    let loads = 0;
    const component = lazyComponent<{ readonly name: string }>(async () => {
      loads += 1;
      return props => `hello ${props.name}`;
    });
    await suspended(() => component({ name: 'a' }));
    expect(component({ name: 'ferret' })).toBe('hello ferret');
    expect(loads).toBe(1);
  });

  it('suspends again on the same pending load instead of starting a second one', async () => {
    let loads = 0;
    const component = lazyComponent<object>(async () => {
      loads += 1;
      return () => 'ready';
    });
    const first = suspended(() => component({}));
    const second = suspended(() => component({}));
    expect(second).toBe(first);
    await first;
    expect(loads).toBe(1);
  });

  it('throws a failed load for the error boundary, every time', async () => {
    const component = lazyComponent<object>(async () => {
      throw new Error('no such module');
    });
    await suspended(() => component({}));
    expect(() => component({})).toThrow('no such module');
    expect(() => component({})).toThrow('no such module');
  });
});
