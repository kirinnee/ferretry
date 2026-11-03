import { describe, expect, it } from 'bun:test';
import type { ReactTestInstance } from 'react-test-renderer';
import {
  Segmented,
  SettingDisclosureRow,
  SettingGroup,
  SettingRow,
  SettingSwitch,
} from '../../../../src/features/settings/setting-row.tsx';
import { render, run } from '../../../support/react.ts';

const byAttr = (root: ReactTestInstance, attr: string): ReactTestInstance[] =>
  root.findAll(node => typeof node.type === 'string' && node.props[attr] !== undefined);

const radios = (root: ReactTestInstance): ReactTestInstance[] =>
  root.findAllByType('input').filter(input => input.props.type === 'radio');

describe('SettingGroup', () => {
  it('titles one card and can carry a setting’s deep-link id', () => {
    const root = render(
      <SettingGroup label="Connection" settingId="connection-preference">
        <li>row</li>
      </SettingGroup>,
    ).root;
    const section = root.findByType('section');

    expect(root.findByType('h3').props.children).toBe('Connection');
    expect(section.props['aria-labelledby']).toBe(root.findByType('h3').props.id);
    expect(section.props.id).toBe('settings-connection-preference');
    expect(section.props['data-setting-id']).toBe('connection-preference');
    expect(section.props.tabIndex).toBe(-1);
    expect(root.findByType('ul').props.className).toContain('kt-groupcard');
  });
});

describe('SettingRow', () => {
  it('is a deep-link target when it is a setting', () => {
    const row = render(<SettingRow settingId="motion" name="Motion" />).root.findByType('li');

    expect(row.props.id).toBe('settings-motion');
    expect(row.props['data-setting-id']).toBe('motion');
    expect(row.props.tabIndex).toBe(-1);
  });

  it('shows the explanation only while its (i) is open, as a real disclosure', () => {
    const renderer = render(<SettingRow name="Motion" hint="Short" explanation="The long, true text." />);
    const info = (): ReactTestInstance => byAttr(renderer.root, 'data-setting-info')[0] as ReactTestInstance;

    expect(info().props['aria-label']).toBe('More about Motion');
    expect(info().props['aria-expanded']).toBe(false);
    expect(byAttr(renderer.root, 'data-setting-explanation')).toHaveLength(0);

    run(() => info().props.onClick());

    expect(info().props['aria-expanded']).toBe(true);
    const panel = byAttr(renderer.root, 'data-setting-explanation')[0] as ReactTestInstance;
    expect(panel.props.id).toBe(info().props['aria-controls']);
    expect(panel.props.children).toBe('The long, true text.');

    run(() => info().props.onClick());
    expect(byAttr(renderer.root, 'data-setting-explanation')).toHaveLength(0);
  });

  it('has no (i) without an explanation', () => {
    expect(byAttr(render(<SettingRow name="Motion" />).root, 'data-setting-info')).toHaveLength(0);
  });

  it('wraps a wide control under the name on a phone, and leaves a small one on the name’s line', () => {
    const wide = render(<SettingRow name="A" wide control={() => <i />} />).root;
    const small = render(<SettingRow name="B" control={() => <i />} />).root;
    const classes = (root: ReactTestInstance): { label: string; controls: string } => ({
      label: root.findAllByType('span')[0]?.props.className as string,
      controls: byAttr(root, 'data-setting-controls')[0]?.props.className as string,
    });

    expect(classes(wide).label).toContain('max-md:basis-full');
    expect(classes(wide).controls).toContain('max-md:basis-full');
    expect(classes(small).label).not.toContain('max-md:basis-full');
    expect(classes(small).controls).not.toContain('max-md:basis-full');
  });

  it('hands the control its label’s id, so a switch is named by the row', () => {
    const root = render(
      <SettingRow
        name="Group"
        control={labelId => <SettingSwitch checked labelledBy={labelId} onChange={() => {}} />}
      />,
    ).root;
    const sw = root.findByProps({ role: 'switch' });
    const label = root.findAllByType('span').find(node => node.props.id === sw.props['aria-labelledby']);

    expect(label?.props.children).toBe('Group');
  });
});

describe('SettingSwitch', () => {
  it('reports the opposite of what it shows', () => {
    const seen: boolean[] = [];
    const sw = render(<SettingSwitch checked={false} labelledBy="x" onChange={v => seen.push(v)} />).root.findByProps({
      role: 'switch',
    });

    expect(sw.props['aria-checked']).toBe(false);
    run(() => sw.props.onClick());
    expect(seen).toEqual([true]);
  });
});

describe('Segmented', () => {
  const options = [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Gamma' },
  ] as const;

  it('is a named radiogroup that is `relative`, with the checked option the one tab stop', () => {
    const root = render(<Segmented label="Pick" value="b" options={options} onChange={() => {}} />).root;
    const group = root.findByProps({ role: 'radiogroup' });

    expect(group.props['aria-label']).toBe('Pick');
    expect(group.props.className).toContain('relative');
    expect(radios(root).map(r => r.props.checked)).toEqual([false, true, false]);
    expect(radios(root).map(r => r.props.tabIndex)).toEqual([-1, 0, -1]);
    expect(radios(root).every(r => r.props.className === 'sr-only')).toBe(true);
  });

  it('keeps the compact height on a desktop and the 44px floor on a phone', () => {
    const root = render(<Segmented label="Pick" value="a" options={options} onChange={() => {}} />).root;

    for (const label of root.findAllByType('label')) {
      expect(label.props.className).toContain('h-control-sm');
      expect(label.props.className).toContain('max-md:min-h-[44px]');
    }
  });

  it('moves and selects with the arrow keys, Home and End, and focuses what it selected', () => {
    const chosen: string[] = [];
    const focused: string[] = [];
    const group = render(
      <Segmented label="Pick" value="b" options={options} onChange={v => chosen.push(v)} />,
    ).root.findByProps({
      role: 'radiogroup',
    });
    const press = (key: string): void => {
      run(() =>
        group.props.onKeyDown({
          key,
          preventDefault: () => {},
          currentTarget: {
            querySelector: (selector: string) => ({ focus: () => focused.push(selector) }),
          },
        }),
      );
    };

    press('ArrowRight');
    press('ArrowLeft');
    press('Home');
    press('End');
    press('x');

    expect(chosen).toEqual(['c', 'a', 'a', 'c']);
    expect(focused).toEqual(['input[value="c"]', 'input[value="a"]', 'input[value="a"]', 'input[value="c"]']);
  });

  it('does not wrap past either end', () => {
    const chosen: string[] = [];
    const group = render(
      <Segmented label="Pick" value="c" options={options} onChange={v => chosen.push(v)} />,
    ).root.findByProps({
      role: 'radiogroup',
    });

    run(() =>
      group.props.onKeyDown({
        key: 'ArrowDown',
        preventDefault: () => {},
        currentTarget: { querySelector: () => null },
      }),
    );

    expect(chosen).toEqual(['c']);
  });

  it('reports a click on an option', () => {
    const chosen: string[] = [];
    const root = render(<Segmented label="Pick" value="a" options={options} onChange={v => chosen.push(v)} />).root;

    run(() => radios(root)[2]?.props.onChange());
    expect(chosen).toEqual(['c']);
  });
});

describe('SettingDisclosureRow', () => {
  it('opens its panel from the whole row and says so with aria-expanded', () => {
    const opened: boolean[] = [];
    const renderer = render(
      <SettingDisclosureRow
        settingId="message-marks"
        name="Message marks"
        value="2 of 6"
        onOpenChange={v => opened.push(v)}
      >
        <p>legend</p>
      </SettingDisclosureRow>,
    );
    const button = (): ReactTestInstance => renderer.root.findByType('button');

    expect(renderer.root.findByType('li').props.id).toBe('settings-message-marks');
    expect(button().props['aria-expanded']).toBe(false);
    expect(byAttr(renderer.root, 'data-setting-panel')).toHaveLength(0);

    run(() => button().props.onClick());

    expect(button().props['aria-expanded']).toBe(true);
    expect(byAttr(renderer.root, 'data-setting-panel')[0]?.props.id).toBe(button().props['aria-controls']);
    expect(opened).toEqual([true]);
  });
});
