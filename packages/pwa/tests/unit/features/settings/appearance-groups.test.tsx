import { describe, expect, it } from 'bun:test';
import type { ReactTestInstance } from 'react-test-renderer';
import { AppearanceGroups } from '../../../../src/features/settings/appearance-groups.tsx';
import type { ThemeState } from '../../../../src/hooks/use-theme.ts';
import { DaemonControlsStore, type Density } from '../../../../src/lib/controls.ts';
import { THEME_FAMILIES } from '../../../../src/lib/theme-preferences.ts';
import { render, run } from '../../../support/react.ts';

const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
};

const setup = (overrides: Partial<ThemeState> = {}) => {
  const controls = new DaemonControlsStore(memory());
  const calls: string[] = [];
  const theme: ThemeState = {
    family: THEME_FAMILIES[0]?.id ?? 'mission',
    mode: 'system',
    textScale: 'default',
    resolved: 'light',
    attr: 'x-light',
    families: THEME_FAMILIES,
    setFamily: id => calls.push(`family:${id}`),
    setMode: mode => calls.push(`mode:${mode}`),
    setTextScale: scale => calls.push(`scale:${scale}`),
    ...overrides,
  } as ThemeState;
  const root = render(
    <ul>
      <AppearanceGroups
        theme={theme}
        densityState={{
          density: 'full',
          explicit: null,
          setDensity: (d: Density) => calls.push(`density:${d}`),
        }}
        device={controls.snapshot().device}
        computerAvailable={false}
        controls={controls}
      />
    </ul>,
  ).root;
  return { root, calls, controls };
};

const groupNamed = (root: ReactTestInstance, label: string): ReactTestInstance =>
  root.find(node => node.props['data-setting-group'] === label);

const rowNames = (group: ReactTestInstance): string[] =>
  group
    .findAll(node => typeof node.type === 'string' && node.props['data-setting-row'] !== undefined)
    .map(n => n.props['data-setting-row']);

describe('AppearanceGroups', () => {
  it('has a Look and a Layout group, each setting a deep-link target', () => {
    const { root } = setup();

    expect(rowNames(groupNamed(root, 'Look'))).toEqual(['Colour mode', 'Theme', 'Text size', 'Motion']);
    expect(rowNames(groupNamed(root, 'Layout'))).toEqual([
      'Density',
      'Conversation width',
      'Group Needs you at the top',
      'Open links in',
      'Message marks',
    ]);
    for (const id of [
      'theme',
      'text-size',
      'motion',
      'density',
      'chat-width',
      'group-needs-you',
      'open-links-in',
      'message-marks',
    ]) {
      expect(root.find(node => node.props.id === `settings-${id}` && node.type === 'li').props.tabIndex).toBe(-1);
    }
  });

  it('writes each choice through the same preference it always did', () => {
    const { root, calls, controls } = setup();
    const radios = (name: string): ReactTestInstance[] =>
      root.find(node => node.props['aria-label'] === name && node.props.role === 'radiogroup').findAllByType('input');

    run(() => radios('Colour mode')[2]?.props.onChange());
    run(() => radios('Text size')[1]?.props.onChange());
    run(() => radios('Dashboard density')[2]?.props.onChange());
    run(() => radios('Motion')[1]?.props.onChange());
    run(() => radios('Conversation width')[2]?.props.onChange());

    expect(calls).toEqual(['mode:dark', 'scale:large', 'density:minimal']);
    expect(controls.snapshot().device.motion).toBe('reduced');
    expect(controls.snapshot().device.chatWidth).toBe('full');
  });

  it('offers a link target the computer only when there is one', () => {
    const { root } = setup();
    const labels = root
      .find(node => node.props['aria-label'] === 'Open links in' && node.props.role === 'radiogroup')
      .findAllByType('label')
      .map(label => label.props.title ?? label.children.join(''));

    expect(labels).toHaveLength(2);
  });

  it('shows the theme families as radio tiles with a light and a dark swatch each', () => {
    const { root, calls } = setup();
    const tiles = root.find(node => node.props['data-theme-tiles'] !== undefined);
    const cards = tiles.findAll(node => typeof node.type === 'string' && node.props['data-family-card'] !== undefined);
    const radios = tiles.findAllByType('input');

    expect(tiles.props.role).toBe('radiogroup');
    expect(tiles.props.className).toContain('grid-cols-2');
    expect(tiles.props.className).toContain('md:grid-cols-4');
    expect(tiles.props.className).toContain('relative');
    expect(cards).toHaveLength(THEME_FAMILIES.length);
    expect(radios.map(r => r.props.checked)).toEqual(THEME_FAMILIES.map((_, i) => i === 0));
    expect(radios.map(r => r.props.tabIndex)).toEqual(THEME_FAMILIES.map((_, i) => (i === 0 ? 0 : -1)));
    expect(cards[0]?.props.className).toContain('border-accent');
    expect(cards[1]?.props.className).not.toContain('border-accent bg-accent-soft');
    expect(cards[0]?.findAll(node => node.props['data-swatch'] !== undefined)).toHaveLength(2);

    run(() => radios[1]?.props.onChange());
    expect(calls).toEqual([`family:${THEME_FAMILIES[1]?.id}`]);
  });

  it('moves the theme with the arrow keys', () => {
    const { root, calls } = setup();
    const tiles = root.find(node => node.props['data-theme-tiles'] !== undefined);

    run(() =>
      tiles.props.onKeyDown({
        key: 'ArrowRight',
        preventDefault: () => {},
      }),
    );

    expect(calls).toEqual([`family:${THEME_FAMILIES[1]?.id}`]);
  });
});
