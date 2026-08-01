import { describe, expect, it } from 'bun:test';

import { DEFAULT_DICTATION_SHORTCUT } from '../../../../src/features/settings/dictation-shortcut.ts';
import { SettingsPage } from '../../../../src/features/settings/settings-page.tsx';
import { type ControlsStorage, DaemonControlsStore } from '../../../../src/lib/controls.ts';
import { daemonId } from '../../../../src/lib/daemon-connection.ts';
import '../../../support/dom.ts';
import { render, run } from '../../../support/react.ts';

const memoryStorage = (): ControlsStorage => {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

const settings = (daemon = daemonId('daemon-alpha')) => {
  const controls = new DaemonControlsStore(memoryStorage());
  const navigated: string[] = [];
  const page = render(
    <SettingsPage
      daemonId={daemon}
      controls={controls}
      dictation={{ binding: DEFAULT_DICTATION_SHORTCUT, onChange: () => {} }}
      onNavigate={to => navigated.push(to)}
    />,
  );
  return { controls, navigated, root: page.root };
};

describe('SettingsPage', () => {
  it('renders every catalog section in the original stable order with one scroll owner', () => {
    const { root } = settings();
    const scroller = root.findByProps({ 'data-settings-scroller': true });
    const sections = root.findAll(node => node.props['data-setting-id'] !== undefined);

    expect(scroller.props.className).toContain('overflow-y-auto');
    expect(sections.map(section => section.props['data-setting-id'])).toEqual([
      'text-size',
      'density',
      'chat-width',
      'composer-markdown',
      'theme',
      'dictation',
      'notifications',
    ]);
    expect(root.findAllByProps({ role: 'status' }).map(node => String(node.children))).toContain(
      'Notification delivery is unavailable until this page is composed with the paired daemon’s push-subscription host.',
    );
  });

  it('keeps settings controls at the touch-target floor and stacks before the desktop breakpoint', () => {
    const { root } = settings();
    const cards = root.findAll(
      node => typeof node.props.className === 'string' && node.props.className.includes('sm:grid-cols-3'),
    );

    expect(cards.length).toBeGreaterThanOrEqual(3);
    for (const card of root.findAll(
      node => typeof node.props.className === 'string' && node.props.className.includes('min-h-[44px]'),
    ))
      expect(card.props.className).toContain('min-h-[44px]');
  });

  it('persists a density choice as a device preference, never against a daemon scope', () => {
    const { controls, root } = settings();
    const compact = root
      .findAllByType('input')
      .find(input => input.props.name === 'dashboard-density' && input.props.value === 'compact');

    run(() => compact?.props.onChange());

    expect(controls.snapshot().device.density).toBe('compact');
    expect(controls.snapshot().scopes).toEqual(Object.create(null));
  });

  it('navigates Warden links and back links within the currently paired daemon only', () => {
    const { navigated, root } = settings(daemonId('daemon beta'));
    const anchors = root.findAllByType('a');
    const back = anchors.find(anchor => anchor.props['aria-label'] === 'Back to sessions');
    const warden = anchors.find(anchor => anchor.props.href === '/d/daemon%20beta/warden#config');

    run(() => back?.props.onClick({ button: 0, preventDefault: () => {} }));
    run(() => warden?.props.onClick({ button: 0, preventDefault: () => {} }));

    expect(navigated).toEqual(['/d/daemon%20beta', '/d/daemon%20beta/warden#config']);
  });

  it('leaves text-scale choices visible but disabled when percentage adjustment is unsupported', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
    Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { supports: () => false } });
    try {
      const { root } = settings();
      expect(root.findByProps({ id: 'text-scale-unsupported' }).props.role).toBe('status');
      for (const input of root.findAllByType('input').filter(input => input.props.name === 'text-scale'))
        expect(input.props.disabled).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'CSS', descriptor);
      else Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'CSS');
    }
  });
});
