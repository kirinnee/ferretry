import { afterEach, describe, expect, it } from 'bun:test';
import { useDebouncedEffect } from '../../src/hooks/use-debounce.ts';
import { render, run } from '../support/react.ts';

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const Probe = ({
  value,
  onSettled,
  delay = 15,
}: {
  value: string;
  onSettled: (value: string) => void;
  delay?: number;
}) => {
  useDebouncedEffect(() => onSettled(value), [value], delay);
  return null;
};

describe('useDebouncedEffect', () => {
  afterEach(() => {
    // Let any timer from a failed assertion finish before the following test mounts.
    return pause(20);
  });

  it('runs after the requested quiet period', async () => {
    const calls: string[] = [];
    const view = render(<Probe value="first" onSettled={value => calls.push(value)} />);

    expect(calls).toEqual([]);
    await pause(20);
    expect(calls).toEqual(['first']);

    view.unmount();
  });

  it('cancels the pending call when a dependency changes', async () => {
    const calls: string[] = [];
    const view = render(<Probe value="stale" onSettled={value => calls.push(value)} delay={25} />);

    await pause(10);
    run(() => view.update(<Probe value="current" onSettled={value => calls.push(value)} delay={25} />));
    await pause(30);

    expect(calls).toEqual(['current']);
    view.unmount();
  });

  it('does not run after unmount', async () => {
    const calls: string[] = [];
    const view = render(<Probe value="gone" onSettled={value => calls.push(value)} delay={20} />);

    view.unmount();
    await pause(25);

    expect(calls).toEqual([]);
  });
});
