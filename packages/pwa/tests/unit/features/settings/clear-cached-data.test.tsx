import { describe, expect, test } from 'bun:test';
import { ClearCachedDataSetting } from '../../../../src/features/settings/clear-cached-data.tsx';
import { interact, mount, must } from '../../../support/dom.ts';

const button = (container: HTMLElement, label: string): HTMLButtonElement =>
  must(
    Array.from(container.querySelectorAll('button')).find(candidate => candidate.textContent?.includes(label)),
    `the "${label}" button`,
  );

const phase = (container: HTMLElement): string | null =>
  must(container.querySelector('[data-clear-cached-data]'), 'the setting').getAttribute('data-clear-cached-data');

describe('ClearCachedDataSetting', () => {
  test('without a way to clear, says this copy keeps nothing and offers no button', async () => {
    // Arrange
    const subject = await mount(<ClearCachedDataSetting />);

    // Act
    const actual = subject.container.textContent;

    // Assert
    try {
      expect(actual).toBe('This copy of Ferretry keeps no cached data.');
      expect(subject.container.querySelectorAll('button')).toHaveLength(0);
    } finally {
      await subject.unmount();
    }
  });

  test('asks once, and "Keep it" returns to idle without clearing', async () => {
    // Arrange
    let cleared = 0;
    const subject = await mount(
      <ClearCachedDataSetting
        onClear={async () => {
          cleared += 1;
        }}
      />,
    );
    try {
      // Act
      await interact(() => button(subject.container, 'Clear cached data').click());
      const asking = phase(subject.container);
      await interact(() => button(subject.container, 'Keep it').click());

      // Assert
      expect(asking).toBe('confirming');
      expect(phase(subject.container)).toBe('idle');
      expect(cleared).toBe(0);
    } finally {
      await subject.unmount();
    }
  });

  test('confirming clears: clearing while storage works, then cleared', async () => {
    // Arrange
    let settle: () => void = () => undefined;
    const pending = new Promise<void>(resolve => {
      settle = resolve;
    });
    const subject = await mount(<ClearCachedDataSetting onClear={() => pending} />);
    try {
      // Act
      await interact(() => button(subject.container, 'Clear cached data').click());
      await interact(() => button(subject.container, 'Clear').click());
      const during = phase(subject.container);
      const duringDisabled = button(subject.container, 'Clearing…').disabled;
      await interact(() => settle());

      // Assert
      expect(during).toBe('clearing');
      expect(duringDisabled).toBe(true);
      expect(phase(subject.container)).toBe('cleared');
      expect(subject.container.textContent).toContain('Cleared');
    } finally {
      await subject.unmount();
    }
  });

  test('a rejected clear says the browser would not, and offers it again', async () => {
    // Arrange
    const subject = await mount(<ClearCachedDataSetting onClear={() => Promise.reject(new Error('quota'))} />);
    try {
      // Act
      await interact(() => button(subject.container, 'Clear cached data').click());
      await interact(() => button(subject.container, 'Clear').click());

      // Assert
      expect(phase(subject.container)).toBe('failed');
      expect(subject.container.textContent).toContain('This browser would not clear it. Try again.');
      expect(button(subject.container, 'Clear cached data').disabled).toBe(false);
    } finally {
      await subject.unmount();
    }
  });
});
