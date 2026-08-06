import { afterEach, describe, expect, it } from 'bun:test';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import {
  CommandPalette,
  type CommandPaletteProps,
  type PaletteDestinationSource,
  type PaletteSettingsSource,
} from '../../src/shell/command-palette.tsx';
import {
  type PaletteCommand,
  paletteSessionEntries,
  type PaletteSettingsEntry,
} from '../../src/shell/palette-model.ts';
import { interact, mount, type Mounted, pressKey } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const alpha = daemonId('alpha');

const destinations: readonly PaletteDestinationSource[] = [
  { id: 'warden', label: 'Warden', title: 'Supervise the fleet', path: id => `/d/${id}/warden` },
];

const sessions = paletteSessionEntries([
  sessionView('s1', { config: { teammate: 'jessica', cwd: '/work/ferretry', label: 'shell' } }),
  sessionView('s2', { config: { teammate: 'meghan', name: 'Port the palette', cwd: '/work/kteam' } }),
]);

interface Harness {
  readonly mounted: Mounted;
  readonly navigated: string[];
  readonly opened: string[];
  readonly closed: () => number;
}

let live: Mounted | undefined;

afterEach(async () => {
  await live?.unmount();
  live = undefined;
});

const open = async (overrides: Partial<CommandPaletteProps> = {}): Promise<Harness> => {
  const navigated: string[] = [];
  const opened: string[] = [];
  let closes = 0;
  const props: CommandPaletteProps = {
    open: true,
    focusSignal: 0,
    onClose: () => {
      closes += 1;
    },
    daemon: alpha,
    sessions,
    destinations,
    onNavigate: href => navigated.push(href),
    onOpenSetting: settingId => opened.push(settingId),
    ...overrides,
  };
  const mounted = await mount(<CommandPalette {...props} />);
  live = mounted;
  return { mounted, navigated, opened, closed: () => closes };
};

const input = (): HTMLInputElement => {
  const element = document.getElementById('fy-palette-input');
  if (!(element instanceof HTMLInputElement)) throw new Error('the palette input is not mounted');
  return element;
};

/**
 * Runs one case at a fixed viewport width. Layout is read from 'window.innerWidth'
 * and sibling suites move it, so every layout-dependent case states its own.
 */
const atWidth = async (width: number, body: () => Promise<void>): Promise<void> => {
  const restore = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  try {
    await body();
  } finally {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: restore });
  }
};

const optionIds = (): string[] =>
  [...document.querySelectorAll('[role="option"]')].map(node => node.getAttribute('id') ?? '');

/** The id at one position in the rendered list, or a failure naming the gap. */
const optionAt = (index: number): string => {
  const ids = optionIds();
  const id = index < 0 ? ids.at(index) : ids[index];
  if (id === undefined) throw new Error(`no option at index ${index} of ${ids.length}`);
  return id;
};

const type = async (value: string): Promise<void> => {
  const field = input();
  await interact(() => {
    // React listens for `input`, and the value has to be set before it fires.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('when closed', () => {
  it('renders nothing at all, so a globally mounted palette costs the page nothing', async () => {
    const { mounted } = await open({ open: false });

    expect(mounted.container.innerHTML).toBe('');
  });
});

describe('the resting palette', () => {
  it('names every searchable result kind on its field', async () => {
    await open();

    const input = document.getElementById('fy-palette-input');
    expect(input?.getAttribute('aria-label')).toBe('Search app destinations, commands, settings, and sessions');
    expect(input?.getAttribute('placeholder')).toBe('Search app destinations, commands, settings, and sessions…');
  });

  it('names each group by what it offers rather than by what matched', async () => {
    await open({ commands: [browserLogin()], settings: settingSource(density()) });

    expect(document.getElementById('fy-palette-group-destinations')?.textContent).toBe('Go to');
    expect(document.getElementById('fy-palette-group-commands')?.textContent).toBe('Actions');
    expect(document.getElementById('fy-palette-group-settings')?.textContent).toBe('Commands');
    expect(document.getElementById('fy-palette-group-sessions')?.textContent).toBe('Recent sessions');
  });

  it('answers "where can I go" before anything else', async () => {
    await open();

    expect(optionIds()[0]).toBe('fy-palette-option-destination-sessions');
  });

  it('points the combobox at the first row and selects it', async () => {
    await open();

    expect(input().getAttribute('aria-activedescendant')).toBe('fy-palette-option-destination-sessions');
    expect(document.querySelector('[aria-selected="true"]')?.getAttribute('id')).toBe(
      'fy-palette-option-destination-sessions',
    );
  });

  it('puts the caret in the query box for a keyboard reader', async () => {
    await open();

    expect(document.activeElement).toBe(input());
  });

  it('leaves the query box alone on touch, so no keyboard covers the results', async () => {
    await open({ touchAffected: true });

    expect(document.activeElement).not.toBe(input());
  });
});

describe('searching', () => {
  it('renames each group to what its rows ARE', async () => {
    await open({ commands: [browserLogin()], settings: settingSource(density()) });
    await type('e');

    expect(document.getElementById('fy-palette-group-commands')?.textContent).toBe('Commands');
    expect(document.getElementById('fy-palette-group-settings')?.textContent).toBe('Settings');
    expect(document.getElementById('fy-palette-group-sessions')?.textContent).toBe('Sessions');
  });

  it('finds a session by its raw callsign, whatever the reader types', async () => {
    await open();
    await type('JESS');

    expect(optionIds()).toContain('fy-palette-option-session-s1');
    expect(optionIds()).not.toContain('fy-palette-option-session-s2');
  });

  it('renders the callsign title-cased even though it matched the raw one', async () => {
    await open();
    await type('jess');

    expect(document.getElementById('fy-palette-option-session-s1')?.textContent).toContain('Jessica');
  });

  it('returns to the top of a new list rather than staying on a row that moved', async () => {
    await open();
    await interact(() => pressKey(input(), 'ArrowDown'));
    await type('jess');

    expect(input().getAttribute('aria-activedescendant')).toBe(optionAt(0));
  });

  it('says what nothing matched, and how to search for it instead', async () => {
    await open({ sessions: [] });
    await type('zzzz');

    const empty = document.querySelector('[role="dialog"] p');
    expect(empty?.textContent).toContain('Nothing matches');
    expect(empty?.textContent).toContain('zzzz');
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
  });

  it('offers the shell destinations even at rest, so a resting palette is never empty', async () => {
    await open({ sessions: [], destinations: [] });

    expect(optionIds()).toEqual([
      'fy-palette-option-destination-sessions',
      'fy-palette-option-destination-new-session',
    ]);
    expect(document.querySelector('[role="dialog"] p')).toBeNull();
  });
});

describe('the keyboard', () => {
  it('moves the active row without ever moving focus out of the combobox', async () => {
    await open();
    await interact(() => pressKey(input(), 'ArrowDown'));

    expect(input().getAttribute('aria-activedescendant')).toBe(optionAt(1));
    expect(document.activeElement).toBe(input());
  });

  it('wraps around both ends and jumps to either of them', async () => {
    await open();
    await interact(() => pressKey(input(), 'ArrowUp'));
    expect(input().getAttribute('aria-activedescendant')).toBe(optionAt(-1));

    await interact(() => pressKey(input(), 'ArrowDown'));
    expect(input().getAttribute('aria-activedescendant')).toBe(optionAt(0));

    await interact(() => pressKey(input(), 'End'));
    expect(input().getAttribute('aria-activedescendant')).toBe(optionAt(-1));

    await interact(() => pressKey(input(), 'Home'));
    expect(input().getAttribute('aria-activedescendant')).toBe(optionAt(0));
  });

  it('leaves a key the list does not answer to alone', async () => {
    await open();
    const before = input().getAttribute('aria-activedescendant');

    await interact(() => pressKey(input(), 'a'));

    expect(input().getAttribute('aria-activedescendant')).toBe(before);
  });

  it('lets an IME candidate window keep the arrow keys while it is up', async () => {
    await open();
    const before = input().getAttribute('aria-activedescendant');

    await interact(() => pressKey(input(), 'ArrowDown', { isComposing: true }));

    expect(input().getAttribute('aria-activedescendant')).toBe(before);
  });

  it('opens the active row on Enter', async () => {
    const harness = await open();

    await interact(() => pressKey(input(), 'Enter'));

    expect(harness.navigated).toEqual(['/d/alpha']);
    expect(harness.closed()).toBe(1);
  });

  it('does nothing on Enter when there is nothing to open', async () => {
    const harness = await open({ sessions: [], destinations: [] });
    await type('zzzz');

    await interact(() => pressKey(input(), 'Enter'));

    expect(harness.navigated).toEqual([]);
    expect(harness.closed()).toBe(0);
  });

  it('closes on Escape', async () => {
    const harness = await open();

    await interact(() => pressKey(document, 'Escape'));

    expect(harness.closed()).toBe(1);
  });
});

describe('opening a row', () => {
  it('navigates to a destination of THIS daemon', async () => {
    const harness = await open();

    await pressRow('fy-palette-option-destination-warden');

    expect(harness.navigated).toEqual(['/d/alpha/warden']);
  });

  it('navigates to a session of THIS daemon', async () => {
    const harness = await open();

    await pressRow('fy-palette-option-session-s1');

    expect(harness.navigated).toEqual(['/d/alpha/session/s1']);
  });

  it('runs a command rather than navigating anywhere', async () => {
    let ran = 0;
    const harness = await open({
      commands: [{ ...browserLogin(), run: () => (ran += 1) }],
    });

    await pressRow('fy-palette-option-command-browser-login');

    expect(ran).toBe(1);
    expect(harness.navigated).toEqual([]);
    expect(harness.closed()).toBe(1);
  });

  it('navigates a settings row that lives on another page entirely', async () => {
    const harness = await open({
      settings: settingSource({ ...density(), href: '/d/alpha/warden#config' }),
    });

    await pressRow('fy-palette-option-setting-density');

    expect(harness.navigated).toEqual(['/d/alpha/warden#config']);
    expect(harness.opened).toEqual([]);
  });

  it('navigates to a settings section’s own anchor on a wide layout', async () => {
    await atWidth(1440, async () => {
      const harness = await open({ settings: settingSource(density()) });

      await pressRow('fy-palette-option-setting-density');

      expect(harness.navigated).toEqual(['/d/alpha/settings#density']);
      expect(harness.opened).toEqual([]);
    });
  });

  it('opens a settings section in place on a phone, after the focus trap has restored', async () => {
    await atWidth(390, async () => {
      const harness = await open({ settings: settingSource(density()) });

      // The handoff is deferred to the next frame on purpose, so the palette's
      // focus trap restores before the settings sheet takes focus.
      await pressRow('fy-palette-option-setting-density');
      await interact(() => new Promise(resolve => requestAnimationFrame(() => resolve(undefined))));

      expect(harness.opened).toEqual(['density']);
      expect(harness.navigated).toEqual([]);
    });
  });

  it('navigates instead when a phone host offers no way to open a section in place', async () => {
    await atWidth(390, async () => {
      const harness = await open({ settings: settingSource(density()), onOpenSetting: undefined });

      await pressRow('fy-palette-option-setting-density');

      expect(harness.navigated).toEqual(['/d/alpha/settings#density']);
    });
  });

  it('does not open a row whose press was cancelled out from under it', async () => {
    const harness = await open();
    const row = document.getElementById('fy-palette-option-session-s1');

    await interact(() => {
      for (const type of ['pointerdown', 'pointercancel', 'pointerup']) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { pointerId: 7 });
        row?.dispatchEvent(event);
      }
    });

    expect(harness.navigated).toEqual([]);
    expect(harness.closed()).toBe(0);
  });

  it('makes a hovered row the active one, so the pointer and the keyboard agree', async () => {
    await open();

    await interact(() =>
      document
        .getElementById('fy-palette-option-session-s1')
        ?.dispatchEvent(new Event('pointermove', { bubbles: true })),
    );

    expect(input().getAttribute('aria-activedescendant')).toBe('fy-palette-option-session-s1');
  });
});

describe('the scrim', () => {
  it('dismisses the palette and is something a screen reader can name', async () => {
    const harness = await open();
    const scrim = document.querySelector('[aria-label="Close the command palette"]');

    await interact(() => scrim?.dispatchEvent(click()));

    expect(harness.closed()).toBe(1);
  });
});

describe('the live region', () => {
  it('waits for the reader to settle before announcing a count', async () => {
    await open();
    const region = document.querySelector('[role="status"]');

    expect(region?.textContent).toBe('');

    await interact(async () => {
      await new Promise(resolve => setTimeout(resolve, 350));
    });

    expect(region?.textContent).toBe(`${optionIds().length} results`);
  });
});

const click = (): MouseEvent => new MouseEvent('click', { bubbles: true, cancelable: true });

/**
 * Activates a row the way a real pointer does. Rows answer to pointer-up after a
 * matching pointer-down — a plain click would not exercise the contract that
 * keeps focus in the query box.
 */
const pressRow = async (id: string): Promise<void> => {
  const row = document.getElementById(id);
  if (!row) throw new Error('no row ' + id);
  await interact(() => {
    for (const type of ['pointerdown', 'pointerup']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { pointerId: 7 });
      row.dispatchEvent(event);
    }
  });
};

const browserLogin = (): PaletteCommand => ({
  id: 'browser-login',
  label: 'Open browser login window',
  description: 'Sign in to shared Chrome',
  searchTerms: 'browser login sign in shared chrome',
  run: () => undefined,
});

const density = (): PaletteSettingsEntry => ({
  id: 'setting-density',
  label: 'Density',
  description: 'How tightly rows pack',
  settingId: 'density',
});

const settingSource =
  (...entries: readonly PaletteSettingsEntry[]): PaletteSettingsSource =>
  () =>
    entries;
