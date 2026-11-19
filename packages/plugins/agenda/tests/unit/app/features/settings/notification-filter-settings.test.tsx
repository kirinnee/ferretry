import { describe, expect, it } from 'bun:test';

import {
  NotificationFilterSettingsView,
  type NotificationFilterSettingsViewProps,
} from '../../../../../app/features/settings/notification-filter-settings.tsx';
import {
  DEFAULT_NOTIFICATION_FILTER_PREFERENCES,
  NOTIFICATION_CATEGORY_COPY,
} from '../../../../../app/lib/notification-filter.ts';
import { render, run } from '@ferretry/app/testing';

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
  it('renders the five category switches on and the quiet-hours switch off by default', () => {
    const { renderer } = view();
    const switches = renderer.root.findAllByProps({ role: 'switch' });
    expect(switches).toHaveLength(6);
    for (const toggle of switches) expect(toggle.props.className).toMatch(/min-h-\[(44|56)px\]/);
    const quietToggle = switches.find(node =>
      node.findAllByType('span').some(span => span.children.includes('Quiet hours')),
    );
    expect(quietToggle?.props['aria-checked']).toBe(false);
    expect(switches.filter(toggle => toggle.props['aria-checked'] === true)).toHaveLength(5);
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

describe('NotificationFilterSettingsView layout (r10 S8)', () => {
  it('says what it is in one line', () => {
    const { renderer } = view();
    const intro = renderer.root.findAllByType('p');
    expect(intro).toHaveLength(1);
    expect(intro[0]?.children.join('')).toBe('What this browser shows. Each machine’s own switch mutes it everywhere.');
  });

  it('lays the five kinds out as a 1 / 2 / 3 column grid of tiles with one line each', () => {
    const { renderer } = view();
    const [grid] = renderer.root.findAllByType('fieldset');
    expect(grid?.props.className).toContain('grid');
    expect(grid?.props.className).toContain('sm:grid-cols-2');
    expect(grid?.props.className).toContain('xl:grid-cols-3');
    const tiles = grid?.findAllByProps({ role: 'switch' }) ?? [];
    expect(tiles).toHaveLength(5);
    for (const tile of tiles) {
      expect(tile.props.title).toBeTruthy(); // the full sentence is kept on hover
      expect(tile.props.className).not.toContain('w-full flex-col');
    }
  });

  it('draws no box inside a tile and no box around the group', () => {
    const { renderer } = view();
    const [grid] = renderer.root.findAllByType('fieldset');
    expect(grid?.props.className).not.toMatch(/\bborder\b(?!-0)/);
    for (const tile of grid?.findAllByProps({ role: 'switch' }) ?? []) {
      // the tile is the one surface: nothing nested under it carries its own border box
      const nested = tile.findAll(
        node =>
          typeof node.type === 'string' &&
          node.type !== 'button' &&
          /\brounded-control\b.*\bborder\b/.test(String(node.props.className ?? '')),
      );
      expect(nested).toHaveLength(0);
    }
  });

  it('keeps quiet hours on one row: its switch, then From / To inline only while on', () => {
    const off = view();
    const rowOff = off.renderer.root.findByProps({ 'data-quiet-hours-row': '' });
    expect(rowOff.props.className).toContain('flex');
    expect(rowOff.findAllByType('input')).toHaveLength(0);
    const on = view({
      preferences: {
        ...DEFAULT_NOTIFICATION_FILTER_PREFERENCES,
        quietHours: { enabled: true, startMinute: 1_320, endMinute: 420 },
      },
    });
    const rowOn = on.renderer.root.findByProps({ 'data-quiet-hours-row': '' });
    const inputs = rowOn.findAllByType('input');
    expect(inputs.map(input => input.props.value)).toEqual(['22:00', '07:00']);
    // same row, same minimum height on and off: turning it on moves nothing below it
    expect(rowOn.props.className).toBe(rowOff.props.className);
  });
});
