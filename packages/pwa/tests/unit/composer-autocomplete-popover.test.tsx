/**
 * The composer's candidate surface, and the send it is now allowed to veto.
 *
 * Before this component the engine ran headless: `/` opened a ready list with a
 * selected row nobody could see, and Enter accepted it instead of sending. So
 * the assertions here are deliberately paired — what the reader SEES, and what
 * Enter is permitted to do given exactly that.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import {
  COMPOSER_REFERENCE_TIERS,
  type ComposerAutocompleteCandidate,
  type ComposerAutocompleteProvider,
  type ComposerTriggerMatch,
} from '../../src/components/composer-autocomplete.ts';
import {
  ComposerAutocompletePopover,
  type ComposerAutocompleteSurface,
} from '../../src/components/composer-autocomplete-popover.tsx';
import { Composer, type ComposerProps } from '../../src/components/composer.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { interact, mount, must } from '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';

const renderers: ReactTestRenderer[] = [];
const mounted = (renderer: ReactTestRenderer): ReactTestRenderer => {
  renderers.push(renderer);
  return renderer;
};

afterEach(() => {
  run(() => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
});

const daemon = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://a.example.test',
  deviceToken: 'token',
});

const surfaceOf = (overrides: Partial<ComposerAutocompleteSurface> = {}): ComposerAutocompleteSurface => ({
  open: true,
  status: 'ready',
  provider: null,
  match: null,
  candidates: [],
  activeIndex: -1,
  listboxId: 'composer-autocomplete-test',
  accept: () => undefined,
  ...overrides,
});

const CANDIDATES: readonly ComposerAutocompleteCandidate[] = [
  { id: 'command-compact', kind: 'command', label: 'compact', detail: 'Free up context', replacement: '/compact' },
  {
    id: 'skill-summary',
    kind: 'skill',
    label: 'summary',
    detail: 'Recap the work',
    group: 'Skills',
    badge: 'project',
    replacement: '/summary',
  },
  {
    id: 'file-secret',
    kind: 'file',
    label: 'secret.env',
    detail: 'src/secret.env',
    group: 'Files',
    replacement: '@src/secret.env',
    disabled: true,
    disabledReason: 'this path is refused by the daemon',
  },
];

const referenceProvider: ComposerAutocompleteProvider = {
  id: 'references:daemon-a:session-a',
  trigger: '@',
  label: 'References',
  legend: COMPOSER_REFERENCE_TIERS,
  candidates: () => ({ candidates: [] }),
};

const tierMatch = (triggerText: string): ComposerTriggerMatch => ({
  trigger: '@',
  triggerText,
  referenceTier: triggerText.length,
  query: '',
  start: 0,
  end: triggerText.length,
  caret: triggerText.length,
});

const options = (view: ReactTestRenderer): ReactTestInstance[] => view.root.findAllByProps({ role: 'option' });
const texts = (view: ReactTestRenderer): string[] => {
  const found: string[] = [];
  view.root
    .findAll(() => true)
    .forEach(node => {
      for (const child of node.children) if (typeof child === 'string') found.push(child);
    });
  return found;
};

describe('composer autocomplete popover', () => {
  test('renders nothing at all while the controller is closed', () => {
    const view = mounted(render(<ComposerAutocompletePopover surface={surfaceOf({ open: false })} />));
    expect(view.toJSON()).toBeNull();
  });

  test('renders ranked candidates in provider sections with the selected row marked', () => {
    const view = mounted(
      render(
        <ComposerAutocompletePopover
          surface={surfaceOf({
            candidates: CANDIDATES,
            activeIndex: 1,
            contextLabel: 'Claude · inserts /name',
            notice: 'Optional: add :LINE before accepting the file.',
          })}
        />,
      ),
    );
    const rows = options(view);
    expect(rows.map(row => row.props.id)).toEqual([
      'composer-autocomplete-test-option-0',
      'composer-autocomplete-test-option-1',
      'composer-autocomplete-test-option-2',
    ]);
    expect(rows.map(row => row.props['aria-selected'])).toEqual([false, true, false]);
    expect(rows[1]?.props.className).toContain('bg-accent-soft');
    // The heading is decoration; the grouping element carries the name, so a
    // screen reader hears "Skills" once rather than twice.
    expect(view.root.findAllByType('fieldset').map(group => group.props['aria-label'])).toEqual(['Skills', 'Files']);
    const rendered = texts(view);
    expect(rendered).toContain('Claude · inserts /name');
    expect(rendered).toContain('compact');
    expect(rendered).toContain('project');
    expect(rendered).toContain('3 suggestions');
    expect(rendered).toContain('Optional: add :LINE before accepting the file.');
  });

  test('shows a refused row honestly and never lets a pointer insert it', () => {
    const accepted: number[] = [];
    const view = mounted(
      render(
        <ComposerAutocompletePopover
          surface={surfaceOf({ candidates: CANDIDATES, activeIndex: 0, accept: index => accepted.push(index) })}
        />,
      ),
    );
    const [first, , refused] = options(view);
    expect(refused?.props['aria-disabled']).toBe(true);
    expect(refused?.props.title).toBe('this path is refused by the daemon');
    expect(refused?.props.className).toContain('cursor-not-allowed');
    // The reason replaces the detail line rather than joining it: the files
    // provider already puts the refusal in `detail`, and printing both reads as
    // two separate problems.
    expect(texts(view)).not.toContain('src/secret.env');
    expect(texts(view)).toContain('this path is refused by the daemon');

    run(() => refused?.props.onPointerDown({ pointerId: 3, preventDefault: () => undefined }));
    run(() => refused?.props.onPointerUp({ pointerId: 3 }));
    expect(accepted).toEqual([]);

    let caretHeld = false;
    run(() =>
      first?.props.onPointerDown({
        pointerId: 1,
        preventDefault: () => {
          caretHeld = true;
        },
      }),
    );
    run(() => first?.props.onPointerUp({ pointerId: 1 }));
    expect(caretHeld).toBe(true);
    expect(accepted).toEqual([0]);
  });

  test('drops an insertion whose pointer was cancelled or lifted elsewhere', () => {
    const accepted: number[] = [];
    const view = mounted(
      render(
        <ComposerAutocompletePopover
          surface={surfaceOf({ candidates: CANDIDATES, accept: index => accepted.push(index) })}
        />,
      ),
    );
    const row = must(options(view)[0], 'the first option');
    run(() => row.props.onPointerDown({ pointerId: 7, preventDefault: () => undefined }));
    run(() => row.props.onPointerCancel());
    run(() => row.props.onPointerUp({ pointerId: 7 }));
    expect(accepted).toEqual([]);

    run(() => row.props.onPointerDown({ pointerId: 7, preventDefault: () => undefined }));
    run(() => row.props.onPointerUp({ pointerId: 9 }));
    expect(accepted).toEqual([]);
  });

  test('reports loading, failure and emptiness instead of an empty box', () => {
    const loading = mounted(render(<ComposerAutocompletePopover surface={surfaceOf({ status: 'loading' })} />));
    expect(loading.root.findAllByProps({ role: 'status' }).length).toBeGreaterThan(0);
    expect(texts(loading)).toContain('Searching…');
    expect(texts(loading)).toContain('Loading suggestions');

    const failed = mounted(
      render(<ComposerAutocompletePopover surface={surfaceOf({ status: 'error', error: 'the daemon said no' })} />),
    );
    expect(failed.root.findAllByProps({ role: 'alert' }).length).toBeGreaterThan(0);
    expect(texts(failed)).toContain('the daemon said no');
    expect(texts(failed)).toContain('Suggestions unavailable');

    const nameless = mounted(render(<ComposerAutocompletePopover surface={surfaceOf({ status: 'error' })} />));
    expect(texts(nameless).filter(text => text === 'Suggestions unavailable')).toHaveLength(2);

    const empty = mounted(render(<ComposerAutocompletePopover surface={surfaceOf({ provider: referenceProvider })} />));
    expect(texts(empty)).toContain('Nothing matches yet');
    // With no context label the provider names itself, and an empty list prints
    // no count chip and no notice footer.
    expect(texts(empty)).toContain('References');
    expect(texts(empty)).toContain('0 suggestions');

    const noticed = mounted(
      render(<ComposerAutocompletePopover surface={surfaceOf({ notice: 'Use one to five @ signs.' })} />),
    );
    expect(texts(noticed)).toContain('Use one to five @ signs.');
  });

  test('teaches the reference tiers and marks the one the caret is in', () => {
    const view = mounted(
      render(
        <ComposerAutocompletePopover
          surface={surfaceOf({
            provider: referenceProvider,
            match: tierMatch('@@'),
            candidates: [CANDIDATES[1] as ComposerAutocompleteCandidate],
            activeIndex: 0,
          })}
        />,
      ),
    );
    const chips = view.root.findAll(node => typeof node.type === 'string' && node.props['data-tier'] !== undefined);
    const active = chips.filter(chip => String(chip.props.className).includes('border-accent'));
    expect(chips).toHaveLength(COMPOSER_REFERENCE_TIERS.length);
    expect(active).toHaveLength(1);
    expect(active[0]?.children).toContain('Agents');
    expect(texts(view)).toContain('1 suggestion');
  });

  test('keeps the selected row in view and inside the element the dismiss guard knows', async () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this.id);
    };
    try {
      const view = await mount(
        <ComposerAutocompletePopover surface={surfaceOf({ candidates: CANDIDATES, activeIndex: 1 })} />,
      );
      expect(scrolled).toEqual(['composer-autocomplete-test-option-1']);
      // The controller dismisses on a click it cannot place inside the element
      // it published as `listboxId`, so every row has to live in that element.
      const listbox = must(document.getElementById('composer-autocomplete-test'), 'the listbox');
      expect(listbox.getAttribute('role')).toBe('listbox');
      expect(listbox.contains(must(document.getElementById('composer-autocomplete-test-option-2'), 'a row'))).toBe(
        true,
      );
      // The chrome still refuses the pointer's default action, so touching the
      // popover cannot pull the caret — or a phone's keyboard — away.
      const popover = must(view.container.querySelector('[data-composer-autocomplete]'), 'the popover');
      const press = new Event('pointerdown', { bubbles: true, cancelable: true });
      await interact(() => popover.dispatchEvent(press));
      expect(press.defaultPrevented).toBe(true);
      await view.unmount();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe('composer send arbitration', () => {
  /**
   * A keyboard-and-pointer desktop, offline. The slash provider answers the
   * first keystroke from its built-in commands, so leaving the skills request
   * in flight is the honest first-keystroke state rather than a stub of one.
   */
  const onDesktop = async (body: () => Promise<void>): Promise<void> => {
    const savedFetch = globalThis.fetch;
    const savedMatchMedia = globalThis.matchMedia;
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: () => new Promise(() => undefined) });
    Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: () => ({ matches: true }) });
    try {
      await body();
    } finally {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: savedFetch });
      Object.defineProperty(globalThis, 'matchMedia', { configurable: true, value: savedMatchMedia });
    }
  };

  const type = (view: ReactTestRenderer, value: string): void => {
    run(() =>
      view.root
        .findByType('textarea')
        .props.onChange({ currentTarget: { value, selectionStart: value.length, selectionEnd: value.length } }),
    );
  };

  const pressEnter = async (view: ReactTestRenderer): Promise<boolean> => {
    let prevented = false;
    // Async: a send that actually reaches the API resolves inside this act.
    await runAsync(async () =>
      view.root.findByType('textarea').props.onKeyDown({
        key: 'Enter',
        shiftKey: false,
        nativeEvent: { isComposing: false },
        preventDefault: () => {
          prevented = true;
        },
      }),
    );
    return prevented;
  };

  const composerFor = (sessionId: string, sent: string[]): ReactTestRenderer =>
    mounted(
      render(
        <Composer
          api={
            {
              send: async (_id: string, body: { message: string }) => {
                sent.push(body.message);
              },
            } as unknown as ComposerProps['api']
          }
          daemon={daemon}
          sessionId={sessionId}
        />,
      ),
    );

  test('shows the slash candidates and lets Enter accept the row the reader can see', async () => {
    await onDesktop(async () => {
      const sent: string[] = [];
      const view = composerFor('session-a', sent);
      type(view, '/');
      const rows = options(view);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.props['aria-selected']).toBe(true);
      expect(view.root.findByType('textarea').props['aria-activedescendant']).toBe(rows[0]?.props.id);

      expect(await pressEnter(view)).toBe(true);
      expect(view.root.findByType('textarea').props.value).toBe('/compact ');
      expect(sent).toEqual([]);
    });
  });

  test('sends when the open list has nothing the reader could accept', async () => {
    await onDesktop(async () => {
      const sent: string[] = [];
      const view = composerFor('session-b', sent);
      type(view, '/zzz');
      expect(options(view)).toHaveLength(0);
      // The list is open and honest about being empty, so Enter is the send it
      // always was.
      expect(texts(view)).toContain('Loading installed skills…');

      expect(await pressEnter(view)).toBe(true);
      expect(sent).toEqual(['/zzz']);
    });
  });

  test('leaves Tab alone unless a visible row would take it', async () => {
    await onDesktop(async () => {
      const view = composerFor('session-c', []);
      type(view, '/zzz');
      let prevented = false;
      run(() =>
        view.root.findByType('textarea').props.onKeyDown({
          key: 'Tab',
          shiftKey: false,
          nativeEvent: { isComposing: false },
          preventDefault: () => {
            prevented = true;
          },
        }),
      );
      expect(prevented).toBe(false);
    });
  });
});
