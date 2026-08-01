import { describe, it } from 'bun:test';
import should from 'should';
import {
  beginDictationShortcutCapture,
  DEFAULT_DICTATION_SHORTCUT,
  DICTATION_SHORTCUT_HOLD_MS,
} from '../../../src/features/settings/dictation-shortcut.ts';
import {
  browserShortcutHost,
  isActiveShortcutComposer,
  isRecordingPhase,
  type ShortcutDictationHandle,
  type ShortcutEventTarget,
  type ShortcutHost,
  shortcutTargetAllowed,
  useDictationShortcut,
} from '../../../src/hooks/use-dictation-shortcut.ts';
import type { DictationPhase } from '../../../src/lib/stt/utterance.ts';
import { render, run } from '../../support/react.ts';

/** A window/document stand-in a test can fire without a DOM. */
class FakeEvents implements ShortcutEventTarget {
  readonly listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event as Event);
  }

  get total(): number {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }
}

interface FakeHost extends ShortcutHost {
  readonly keys: FakeEvents;
  readonly visibility: FakeEvents;
  hidden: boolean;
  clock: number;
}

const makeHost = (): FakeHost => {
  const keys = new FakeEvents();
  const visibility = new FakeEvents();
  const host: FakeHost = {
    keys,
    visibility,
    hidden: false,
    clock: 0,
    visibilityState: () => (host.hidden ? 'hidden' : 'visible'),
    now: () => host.clock,
  };
  return host;
};

/** A composer element the eligibility rules will accept. */
const eligibleComposer = (): HTMLElement => ({ isConnected: true, closest: () => null }) as unknown as HTMLElement;

const keyEvent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  key: 'Alt',
  code: 'AltLeft',
  metaKey: false,
  ctrlKey: false,
  altKey: true,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  keyCode: 18,
  target: null,
  preventDefault: () => undefined,
  stopPropagation: () => undefined,
  ...overrides,
});

interface Recorded {
  readonly actions: string[];
}

const Probe = ({
  host,
  composer,
  phase,
  recorded,
  disabled,
}: {
  host: ShortcutHost | null;
  composer: HTMLElement | null;
  phase: DictationPhase;
  recorded: Recorded;
  disabled?: boolean;
}): null => {
  const handle: ShortcutDictationHandle = {
    phase,
    start: () => void recorded.actions.push('start'),
    stop: () => void recorded.actions.push('stop'),
  };
  useDictationShortcut({
    binding: DEFAULT_DICTATION_SHORTCUT,
    handle,
    composerRef: { current: composer },
    host,
    disabled,
  });
  return null;
};

const mount = (
  host: ShortcutHost | null,
  options: { composer?: HTMLElement | null; phase?: DictationPhase; disabled?: boolean } = {},
): { readonly recorded: Recorded; readonly renderer: ReturnType<typeof render> } => {
  const recorded: Recorded = { actions: [] };
  const renderer = render(
    <Probe
      host={host}
      composer={options.composer === undefined ? eligibleComposer() : options.composer}
      phase={options.phase ?? 'idle'}
      recorded={recorded}
      disabled={options.disabled}
    />,
  );
  return { recorded, renderer };
};

describe('isActiveShortcutComposer', () => {
  it('accepts a live composer in the visible pane', () => {
    should(isActiveShortcutComposer({ isConnected: true, closest: () => null })).be.true();
  });

  it('refuses a retained pane the shell has hidden', () => {
    should(isActiveShortcutComposer({ isConnected: true, closest: () => ({}) })).be.false();
  });

  it('refuses a composer that is gone or was never mounted', () => {
    should(isActiveShortcutComposer(null)).be.false();
    should(isActiveShortcutComposer({ isConnected: false })).be.false();
  });

  it('accepts an element too plain to ask about ancestors', () => {
    should(isActiveShortcutComposer({ isConnected: true })).be.true();
  });
});

describe('shortcutTargetAllowed', () => {
  const composer = eligibleComposer();

  it('always allows the composer itself', () => {
    should(shortcutTargetAllowed(composer, composer)).be.true();
  });

  it('refuses a dialog, a modal and the settings scroller', () => {
    should(
      shortcutTargetAllowed({ closest: (selector: string) => (selector.includes('dialog') ? {} : null) }, composer),
    ).be.false();
  });

  it('refuses another text field', () => {
    should(
      shortcutTargetAllowed({ closest: (selector: string) => (selector.includes('textarea') ? {} : null) }, composer),
    ).be.false();
  });

  it('refuses a bare form control by its tag', () => {
    should(shortcutTargetAllowed({ tagName: 'INPUT' }, composer)).be.false();
    should(shortcutTargetAllowed({ tagName: 'SELECT' }, composer)).be.false();
    should(shortcutTargetAllowed({ isContentEditable: true }, composer)).be.false();
  });

  it('allows an ordinary element and a non-object target', () => {
    should(shortcutTargetAllowed({ tagName: 'DIV', closest: () => null }, composer)).be.true();
    should(shortcutTargetAllowed(null, composer)).be.true();
    should(shortcutTargetAllowed('window', composer)).be.true();
  });
});

describe('isRecordingPhase', () => {
  it('counts the microphone as open while it is being requested', () => {
    should(isRecordingPhase('requesting')).be.true();
    should(isRecordingPhase('recording')).be.true();
    should(isRecordingPhase('transcribing')).be.false();
    should(isRecordingPhase('idle')).be.false();
  });
});

describe('useDictationShortcut', () => {
  it('starts on the chord and finishes when the hold is released', () => {
    const host = makeHost();
    const { recorded } = mount(host);

    run(() => host.keys.emit('keydown', keyEvent()));
    host.clock = DICTATION_SHORTCUT_HOLD_MS;
    run(() => host.keys.emit('keyup', keyEvent()));

    should(recorded.actions).deepEqual(['start', 'stop']);
  });

  it('claims the key it matched, so a browser menu never sees bare Alt', () => {
    const host = makeHost();
    mount(host);
    const counts: string[] = [];

    run(() =>
      host.keys.emit(
        'keydown',
        keyEvent({ preventDefault: () => counts.push('prevent'), stopPropagation: () => counts.push('stop') }),
      ),
    );

    should(counts).deepEqual(['prevent', 'stop']);
  });

  it('leaves an unmatched key completely alone', () => {
    const host = makeHost();
    const { recorded } = mount(host);
    const counts: string[] = [];

    run(() =>
      host.keys.emit(
        'keydown',
        keyEvent({ key: 'k', code: 'KeyK', altKey: false, preventDefault: () => counts.push('prevent') }),
      ),
    );

    should(recorded.actions).deepEqual([]);
    should(counts).deepEqual([]);
  });

  it('ignores auto-repeat after claiming the key', () => {
    const host = makeHost();
    const { recorded } = mount(host);

    run(() => host.keys.emit('keydown', keyEvent()));
    run(() => host.keys.emit('keydown', keyEvent({ repeat: true })));

    should(recorded.actions).deepEqual(['start']);
  });

  it('ignores an IME composition', () => {
    const host = makeHost();
    const { recorded } = mount(host);

    run(() => host.keys.emit('keydown', keyEvent({ isComposing: true })));
    run(() => host.keys.emit('keydown', keyEvent({ keyCode: 229 })));

    should(recorded.actions).deepEqual([]);
  });

  it('stays silent while the picker is capturing keys', () => {
    const host = makeHost();
    const { recorded } = mount(host);
    const release = beginDictationShortcutCapture();

    run(() => host.keys.emit('keydown', keyEvent()));
    run(() => host.keys.emit('keyup', keyEvent()));
    release();

    should(recorded.actions).deepEqual([]);
  });

  it('does not fire for a composer in a retained, hidden pane', () => {
    const host = makeHost();
    const { recorded } = mount(host, {
      composer: { isConnected: true, closest: () => ({}) } as unknown as HTMLElement,
    });

    run(() => host.keys.emit('keydown', keyEvent()));
    run(() => host.keys.emit('keyup', keyEvent()));

    should(recorded.actions).deepEqual([]);
  });

  it('does not steal the key from a dialog', () => {
    const host = makeHost();
    const { recorded } = mount(host);
    const target = { closest: (selector: string) => (selector.includes('dialog') ? {} : null) };

    run(() => host.keys.emit('keydown', keyEvent({ target })));

    should(recorded.actions).deepEqual([]);
  });

  it('releases a capture when the window loses focus', () => {
    const host = makeHost();
    const { recorded } = mount(host);

    run(() => host.keys.emit('keydown', keyEvent()));
    run(() => host.keys.emit('blur', {}));

    should(recorded.actions).deepEqual(['start', 'stop']);
  });

  it('releases a capture when the tab goes to the background, and not otherwise', () => {
    const host = makeHost();
    const { recorded } = mount(host);

    run(() => host.keys.emit('keydown', keyEvent()));
    run(() => host.visibility.emit('visibilitychange', {}));
    should(recorded.actions).deepEqual(['start']);

    host.hidden = true;
    run(() => host.visibility.emit('visibilitychange', {}));
    should(recorded.actions).deepEqual(['start', 'stop']);
  });

  it('stops a capture some other control started', () => {
    const host = makeHost();
    const { recorded } = mount(host, { phase: 'recording' });

    run(() => host.keys.emit('keydown', keyEvent()));
    should(recorded.actions).deepEqual(['stop']);
  });

  it('detaches every listener on unmount, releasing as it goes', () => {
    const host = makeHost();
    const { recorded, renderer } = mount(host);

    run(() => host.keys.emit('keydown', keyEvent()));
    run(() => renderer.unmount());

    should(recorded.actions).deepEqual(['start', 'stop']);
    should(host.keys.total).equal(0);
    should(host.visibility.total).equal(0);
  });

  it('listens to nothing at all when disabled or hostless', () => {
    const host = makeHost();
    mount(host, { disabled: true });
    should(host.keys.total).equal(0);

    const { recorded } = mount(null);
    should(recorded.actions).deepEqual([]);
  });
});

describe('browserShortcutHost', () => {
  it('binds the real window and document without reaching for either itself', () => {
    const listeners: string[] = [];
    const target = {
      addEventListener: (type: string) => void listeners.push(type),
      removeEventListener: () => undefined,
      performance: { now: () => 42 },
    };
    const document = { visibilityState: 'visible' } as Document;
    const host = browserShortcutHost(target as unknown as Window & typeof globalThis, document);

    host.keys.addEventListener('keydown', () => undefined);
    should(listeners).deepEqual(['keydown']);
    should(host.now()).equal(42);
    should(host.visibilityState()).equal('visible');
  });
});
