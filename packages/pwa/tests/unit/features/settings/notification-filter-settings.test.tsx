import { describe, expect, it } from 'bun:test';

import {
  NotificationFilterSettingsView,
  type NotificationFilterSettingsViewProps,
} from '../../../../src/features/settings/notification-filter-settings.tsx';
import {
  DEFAULT_NOTIFICATION_FILTER_PREFERENCES,
  NOTIFICATION_CATEGORY_COPY,
} from '../../../../src/lib/notification-filter.ts';
import { render, run } from '../../../support/react.ts';

const view = (overrides: Partial<NotificationFilterSettingsViewProps> = {}) => {
  const calls = {
    categories: [] as [string, boolean][],
    quietHours: [] as object[],
  };
  const props: NotificationFilterSettingsViewProps = {
    preferences: DEFAULT_NOTIFICATION_FILTER_PREFERENCES,
    onCategoryChange: (category, next) => calls.categories.push([category, next]),
    onQuietHoursChange: patch => calls.quietHours.push(patch),
    ...overrides,
  };
  return { calls, renderer: render(<NotificationFilterSettingsView {...props} />) };
};

describe('NotificationFilterSettingsView', () => {
  it('renders the four category switches on and the quiet-hours switch off by default', () => {
    const { renderer } = view();
    const switches = renderer.root.findAllByProps({ role: 'switch' });
    expect(switches).toHaveLength(5);
    for (const toggle of switches) expect(toggle.props.className).toContain('min-h-[44px]');
    const quietToggle = switches.find(node =>
      node.findAllByType('span').some(span => span.children.includes('Quiet hours')),
    );
    expect(quietToggle?.props['aria-checked']).toBe(false);
    expect(switches.filter(toggle => toggle.props['aria-checked'] === true)).toHaveLength(4);
  });

  it('flips exactly the category switch that was pressed', () => {
    const { calls, renderer } = view();
    const failedToggle = renderer.root
      .findAllByProps({ role: 'switch' })
      .find(node =>
        node.findAllByType('span').some(span => span.children.includes(NOTIFICATION_CATEGORY_COPY.failed.label)),
      );
    run(() => failedToggle?.props.onClick());
    expect(calls.categories).toEqual([['failed', false]]);
  });

  it('hides the time inputs until quiet hours is on, then reports a parsed minute', () => {
    const before = view();
    expect(before.renderer.root.findAllByType('input')).toHaveLength(0);

    const { calls, renderer } = view({
      preferences: {
        ...DEFAULT_NOTIFICATION_FILTER_PREFERENCES,
        quietHours: { enabled: true, startMinute: 0, endMinute: 0 },
      },
    });
    const inputs = renderer.root.findAllByType('input');
    expect(inputs).toHaveLength(2);
    expect(inputs[0]?.props.value).toBe('00:00');
    run(() => inputs[0]?.props.onChange({ target: { value: '22:30' } }));
    expect(calls.quietHours).toEqual([{ startMinute: 1_350 }]);
  });

  it('ignores an unparseable time rather than calling the patch with garbage', () => {
    const { calls, renderer } = view({
      preferences: {
        ...DEFAULT_NOTIFICATION_FILTER_PREFERENCES,
        quietHours: { enabled: true, startMinute: 0, endMinute: 0 },
      },
    });
    const [, end] = renderer.root.findAllByType('input');
    run(() => end?.props.onChange({ target: { value: 'not a time' } }));
    expect(calls.quietHours).toEqual([]);
  });

  it('turns quiet hours on from its own switch', () => {
    const { calls, renderer } = view();
    const quietToggle = renderer.root
      .findAllByProps({ role: 'switch' })
      .find(node => node.findAllByType('span').some(span => span.children.includes('Quiet hours')));
    run(() => quietToggle?.props.onClick());
    expect(calls.quietHours).toEqual([{ enabled: true }]);
  });
});
