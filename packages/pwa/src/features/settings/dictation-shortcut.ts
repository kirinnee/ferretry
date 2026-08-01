/** Browser-independent push-to-talk shortcut policy. */
type DictationShortcutModifier = 'Meta' | 'Control' | 'Alt' | 'Shift';

export interface DictationShortcutBinding {
  readonly code: string;
  readonly key: string;
  readonly modifiers: readonly DictationShortcutModifier[];
}

export const DEFAULT_DICTATION_SHORTCUT: Readonly<DictationShortcutBinding> = Object.freeze({
  code: 'Alt',
  key: 'Alt',
  modifiers: Object.freeze([]) as readonly DictationShortcutModifier[],
});

export const BARE_ALT_WARNING =
  'Bare Alt can be intercepted by a browser menu or window manager before this page sees it. Use Change and press then release Alt here to test this browser, or choose another chord.';

const MODIFIER_ORDER: readonly DictationShortcutModifier[] = ['Meta', 'Control', 'Alt', 'Shift'];
const MODIFIER_CODES: Readonly<Record<DictationShortcutModifier, readonly string[]>> = {
  Meta: ['Meta', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'],
  Control: ['Control', 'ControlLeft', 'ControlRight'],
  Alt: ['Alt', 'AltLeft', 'AltRight'],
  Shift: ['Shift', 'ShiftLeft', 'ShiftRight'],
};

export interface ShortcutKeyboardEvent {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export interface DictationShortcutVerdict {
  readonly ok: boolean;
  readonly reason?: string;
  readonly warning?: string;
}

const primaryModifier = (code: string): DictationShortcutModifier | null =>
  MODIFIER_ORDER.find(modifier => MODIFIER_CODES[modifier].includes(code)) ?? null;

const eventModifiers = (event: ShortcutKeyboardEvent, primaryCode: string): DictationShortcutModifier[] => {
  const active: DictationShortcutModifier[] = [];
  if (event.metaKey) active.push('Meta');
  if (event.ctrlKey) active.push('Control');
  if (event.altKey) active.push('Alt');
  if (event.shiftKey) active.push('Shift');
  const own = primaryModifier(primaryCode);
  return own === null ? active : active.filter(modifier => modifier !== own);
};

export const dictationShortcutFromEvent = (event: ShortcutKeyboardEvent): DictationShortcutBinding => {
  const code = (event.code || event.key).slice(0, 48);
  return { code, key: event.key.slice(0, 24), modifiers: eventModifiers(event, code) };
};

const isPrintablePrimary = (binding: DictationShortcutBinding): boolean =>
  binding.key.length === 1 || /^(?:Key[A-Z]|Digit[0-9]|Numpad[0-9]|Space)$/u.test(binding.code);

const isBare = (binding: DictationShortcutBinding): boolean =>
  binding.modifiers.length === 0 && primaryModifier(binding.code) === null;

const hasCommandModifier = (binding: DictationShortcutBinding): boolean =>
  binding.modifiers.some(modifier => modifier === 'Meta' || modifier === 'Control' || modifier === 'Alt');

const exactModifiers = (binding: DictationShortcutBinding, expected: readonly DictationShortcutModifier[]): boolean =>
  binding.modifiers.length === expected.length && expected.every(modifier => binding.modifiers.includes(modifier));

/** Reject shortcuts a web page cannot safely own before a reader saves one. */
export function validateDictationShortcut(binding: DictationShortcutBinding): DictationShortcutVerdict {
  if (!binding.code || !binding.key) return { ok: false, reason: 'Press a real key or key combination.' };
  const ownModifier = primaryModifier(binding.code);
  if (ownModifier === 'Alt' && binding.modifiers.length === 0) return { ok: true, warning: BARE_ALT_WARNING };
  if (ownModifier !== null && binding.modifiers.length === 0)
    return {
      ok: false,
      reason: `${ownModifier} by itself is reserved for typing or system controls. Add another key.`,
    };
  if (isPrintablePrimary(binding) && !hasCommandModifier(binding))
    return {
      ok: false,
      reason: 'A bare printable key (or Shift plus a printable key) would fire while you type in the composer.',
    };
  if (binding.code === 'KeyK' && (exactModifiers(binding, ['Meta']) || exactModifiers(binding, ['Control'])))
    return { ok: false, reason: '⌘K / Ctrl K already opens the command palette.' };
  if (
    new Set(['KeyL', 'KeyT', 'KeyW', 'KeyR', 'KeyN', 'KeyP', 'KeyF', 'KeyS', 'KeyO']).has(binding.code) &&
    (exactModifiers(binding, ['Meta']) || exactModifiers(binding, ['Control']))
  )
    return { ok: false, reason: 'That chord is a standard browser command and may never reach this page.' };
  if (
    (binding.code === 'Tab' && binding.modifiers.includes('Alt')) ||
    (binding.code === 'F4' && binding.modifiers.includes('Alt')) ||
    (binding.code === 'Space' && binding.modifiers.includes('Meta')) ||
    (binding.code === 'Delete' && exactModifiers(binding, ['Control', 'Alt']))
  )
    return { ok: false, reason: 'The operating system reserves that chord before a web page can observe it.' };
  if (['F1', 'F5', 'F6', 'F11', 'F12'].includes(binding.code))
    return { ok: false, reason: 'That function key is reserved by common browser controls.' };
  if (
    isBare(binding) &&
    (isPrintablePrimary(binding) ||
      ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
        binding.code,
      ))
  )
    return { ok: false, reason: 'That bare key already edits or navigates the composer.' };
  return { ok: true };
}

const codeLabel = (binding: DictationShortcutBinding): string => {
  if (binding.code === 'Alt') return 'Alt (either side)';
  const known: Record<string, string> = {
    AltLeft: 'Left Alt',
    AltRight: 'Right Alt',
    ControlLeft: 'Left Ctrl',
    ControlRight: 'Right Ctrl',
    MetaLeft: 'Left Meta',
    MetaRight: 'Right Meta',
    ShiftLeft: 'Left Shift',
    ShiftRight: 'Right Shift',
    Space: 'Space',
  };
  const knownLabel = known[binding.code];
  if (knownLabel !== undefined) return knownLabel;
  if (/^Key[A-Z]$/u.test(binding.code)) return binding.code.slice(3);
  if (/^Digit[0-9]$/u.test(binding.code)) return binding.code.slice(5);
  return binding.key === ' ' ? 'Space' : binding.key || binding.code;
};

export const dictationShortcutLabel = (binding: DictationShortcutBinding): string => {
  const labels: Record<DictationShortcutModifier, string> = {
    Meta: 'Meta',
    Control: 'Ctrl',
    Alt: 'Alt',
    Shift: 'Shift',
  };
  return [...binding.modifiers.map(modifier => labels[modifier]), codeLabel(binding)].join(' + ');
};

export const sameDictationShortcutTrigger = (
  binding: DictationShortcutBinding,
  event: Pick<ShortcutKeyboardEvent, 'code' | 'key'>,
): boolean =>
  binding.code === 'Alt'
    ? event.key === 'Alt' || event.code === 'AltLeft' || event.code === 'AltRight'
    : event.code === binding.code || (!event.code && event.key === binding.key);

let captureDepth = 0;

/** Stops retained composer listeners from hearing keys used to test a shortcut. */
export function beginDictationShortcutCapture(): () => void {
  captureDepth += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    captureDepth = Math.max(0, captureDepth - 1);
  };
}
