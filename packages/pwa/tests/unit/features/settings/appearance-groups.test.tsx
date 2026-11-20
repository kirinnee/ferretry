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

const setup = (overrides: Partial<ThemeState> = {}, googleMapsAvailable = false) => {
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
        googleMapsAvailable={googleMapsAvailable}
      />
    </ul>,
  ).root;
  return { root, calls, controls };
};

const groupNamed = (root: ReactTestInstance, label: string): ReactTestInstance =>
  root.find(node => node.props['data-setting-group'] === label);

/** Every string under a node, joined: what a reader would read. */
const textOf = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join(' ');

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

  it('offers Map style only in a build that carries the Google Maps key, and says what Google sees', () => {
    const without = setup().root;
    expect(rowNames(groupNamed(without, 'Layout'))).not.toContain('Map style');

    const { root, controls } = setup({}, true);
    expect(rowNames(groupNamed(root, 'Layout'))).toEqual([
      'Density',
      'Conversation width',
      'Group Needs you at the top',
      'Open links in',
      'Map style',
      'Message marks',
    ]);
    const row = root.find(node => node.props['data-setting-row'] === 'Map style');
    expect(textOf(row)).toContain('Google sees which places you open');
    const group = root.find(node => node.props['aria-label'] === 'Map style' && node.props.role === 'radiogroup');
    const labels = group.findAllByType('label').map(label => textOf(label));
    expect(labels.join('|')).toContain('OpenStreetMap');
    expect(labels.join('|')).toContain('Google Maps');
    expect(controls.snapshot().device.mapStyle).toBe('osm');
    run(() => group.findAllByType('input')[1]?.props.onChange());
    expect(controls.snapshot().device.mapStyle).toBe('google');
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

  it('jumps to the first or last family with Home and End, and steps back with ArrowUp and ArrowLeft', () => {
    const middle = THEME_FAMILIES[2]?.id;
    const { root, calls } = setup(middle === undefined ? {} : { family: middle });
    const tiles = root.find(node => node.props['data-theme-tiles'] !== undefined);
    const press = (key: string) => run(() => tiles.props.onKeyDown({ key, preventDefault: () => {} }));

    press('Home');
    press('End');
    press('ArrowUp');
    press('ArrowLeft');

    expect(calls).toEqual([
      `family:${THEME_FAMILIES[0]?.id}`,
      `family:${THEME_FAMILIES[THEME_FAMILIES.length - 1]?.id}`,
      `family:${THEME_FAMILIES[1]?.id}`,
      `family:${THEME_FAMILIES[1]?.id}`,
    ]);
  });

  it('keeps every option’s explanation behind the (i) of its row, not only the chosen one', () => {
    const { root } = setup();
    const explanationOf = (name: string): string => {
      const row = root.find(node => node.type === 'li' && node.props['data-setting-row'] === name);
      run(() => row.findByProps({ 'data-setting-info': '' }).props.onClick());
      return textOf(row.find(node => node.props['data-setting-explanation'] !== undefined));
    };

    const text = explanationOf('Text size');
    expect(text).toContain('Use the interface’s designed size.');
    expect(text).toContain('112% of default.');
    expect(text).toContain('125% of default.');
    expect(text).toContain('Sizes never go below Default');
    const density = explanationOf('Density');
    for (const sentence of [
      'Show the available session detail.',
      'Keep rows easy to scan.',
      'Prioritise the session names.',
    ])
      expect(density).toContain(sentence);
    const width = explanationOf('Conversation width');
    for (const sentence of [
      'Default. A 720px column, centred — easiest to read.',
      'A 1200px column, with room for code and wide tables.',
      'The whole width of the conversation pane.',
      'Compact is active: messages and the composer stay within a 720px column.',
      'the choices look the same.',
    ])
      expect(width).toContain(sentence);
    const motion = explanationOf('Motion');
    expect(motion).toContain('Animations play unless this device asks for less motion.');
    expect(motion).toContain('Spinners and transitions stay still on this device.');
    const mode = explanationOf('Colour mode');
    for (const sentence of ['Follow the operating system', 'Always light', 'Always dark', 'Auto follows the OS live.'])
      expect(mode).toContain(sentence);
    const themeRow = explanationOf('Theme');
    for (const option of THEME_FAMILIES) expect(themeRow).toContain(option.blurb);
  });
});
