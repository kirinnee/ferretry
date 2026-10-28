import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, RotateCcw } from 'lucide-react';

import { Button } from '../../shell/primitives.tsx';
import {
  beginDictationShortcutCapture,
  DEFAULT_DICTATION_SHORTCUT,
  dictationShortcutFromEvent,
  dictationShortcutLabel,
  sameDictationShortcutTrigger,
  validateDictationShortcut,
  type DictationShortcutBinding,
  type DictationShortcutVerdict,
} from './dictation-shortcut.ts';

export interface DictationShortcutPickerProps {
  readonly binding: DictationShortcutBinding;
  readonly onChange: (binding: DictationShortcutBinding) => void;
}

interface PendingShortcut {
  readonly binding: DictationShortcutBinding;
  readonly verdict: DictationShortcutVerdict;
}

const sameBinding = (a: DictationShortcutBinding, b: DictationShortcutBinding): boolean =>
  a.code === b.code && a.key === b.key && a.modifiers.join('+') === b.modifiers.join('+');

const CAPTURE_BUTTON_SELECTOR = '[data-dictation-capture]';

const OS_TOOK_FOCUS_MESSAGE =
  'The browser or operating system took focus before keyup, so that chord cannot be trusted here.';

/**
 * A key-capture control which saves only after matching keydown and keyup.
 *
 * Keys are heard on the window in the capture phase, not on the button: WebKit
 * (Safari, every iOS and iPadOS browser) does not focus a button that is tapped
 * or clicked, so a button-scoped listener never hears a hardware keyboard there.
 */
export function DictationShortcutPicker({ binding, onChange }: DictationShortcutPickerProps) {
  const [capturing, setCapturing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [tone, setTone] = useState<'muted' | 'warn' | 'ok'>('muted');
  const pending = useRef<PendingShortcut | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const cancel = useCallback((message = 'Shortcut capture cancelled.'): void => {
    pending.current = null;
    setCapturing(false);
    setTone('muted');
    setFeedback(message);
  }, []);

  useEffect(() => {
    if (!capturing) return undefined;
    const releaseCapture = beginDictationShortcutCapture();

    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (event.key === 'Escape') {
        cancel();
        return;
      }
      const candidate = dictationShortcutFromEvent(event);
      pending.current = { binding: candidate, verdict: validateDictationShortcut(candidate) };
      setTone('muted');
      setFeedback(`Release ${dictationShortcutLabel(candidate)} to test and confirm it.`);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const candidate = pending.current;
      if (!candidate || !sameDictationShortcutTrigger(candidate.binding, event)) return;
      pending.current = null;
      if (!candidate.verdict.ok) {
        setTone('warn');
        setFeedback(candidate.verdict.reason ?? 'That shortcut cannot be used here. Try another.');
        return;
      }
      onChangeRef.current(candidate.binding);
      setCapturing(false);
      setTone(candidate.verdict.warning ? 'warn' : 'ok');
      setFeedback(candidate.verdict.warning ?? `${dictationShortcutLabel(candidate.binding)} saved.`);
    };
    const onFocusLost = (): void => cancel(pending.current ? OS_TOOK_FOCUS_MESSAGE : undefined);
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') onFocusLost();
    };
    // WebKit never blurs the button it never focused, so a tap elsewhere is the only signal that capture is over.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      const onButton =
        typeof target === 'object' &&
        target !== null &&
        typeof (target as Element).closest === 'function' &&
        (target as Element).closest(CAPTURE_BUTTON_SELECTOR) !== null;
      if (!onButton) cancel();
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onFocusLost);
    window.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onFocusLost);
      window.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('visibilitychange', onVisibility);
      releaseCapture();
    };
  }, [capturing, cancel]);

  const currentVerdict = validateDictationShortcut(binding);
  const isDefault = sameBinding(binding, DEFAULT_DICTATION_SHORTCUT);
  const feedbackClass =
    tone === 'warn' || (!feedback && currentVerdict.warning) ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-faint';

  return (
    <section
      aria-labelledby="dictation-shortcut-title"
      className="flex flex-col gap-2 rounded-control border border-border bg-surface-2 p-3"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 id="dictation-shortcut-title" className="m-0 text-ui font-semibold text-fg">
            Push to talk
          </h3>
          <p className="m-0 text-meta leading-base text-muted">
            Hold to record and release to finish, or tap once to latch and press again to finish.
          </p>
        </div>
        <kbd className="inline-flex min-h-8 items-center gap-1 rounded-control border border-accent bg-accent-soft px-2 font-ui text-meta font-semibold text-accent shadow-sm">
          <KeyRound size={13} aria-hidden="true" />
          {dictationShortcutLabel(binding)}
        </kbd>
      </div>
      <p className="m-0 text-meta leading-base text-muted">
        The finished transcript and one correction pass insert at your current caret. The shortcut never sends the
        message. On a phone, use the mic button—the keyboard shortcut is optional. On an iPad keyboard, Option is Alt
        and the Globe key never reaches the page; if Alt alone does nothing, press Change and try another chord.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={capturing ? 'primary' : 'outline'}
          className="min-h-[44px] min-w-[44px]"
          aria-pressed={capturing}
          data-dictation-capture=""
          onClick={event => {
            if (capturing) cancel();
            else {
              pending.current = null;
              setTone('muted');
              setFeedback('Press your shortcut, then release its main key. Escape cancels.');
              setCapturing(true);
              // Focus is not needed to hear keys, but it keeps screen readers and the focus ring on the control.
              event.currentTarget.focus();
            }
          }}
        >
          <KeyRound size={14} aria-hidden="true" />
          <span className="ml-1">{capturing ? 'Listening — press a shortcut' : 'Change shortcut'}</span>
        </Button>
        {!isDefault && (
          <Button
            type="button"
            size="sm"
            className="min-h-[44px] min-w-[44px]"
            onClick={() => {
              onChange({ ...DEFAULT_DICTATION_SHORTCUT });
              setTone('muted');
              setFeedback('Reset to Alt (either side).');
            }}
          >
            <RotateCcw size={14} aria-hidden="true" />
            <span className="ml-1">Use default Alt</span>
          </Button>
        )}
      </div>
      {(feedback || currentVerdict.warning) && (
        <p className={`m-0 text-meta leading-base ${feedbackClass}`} role="status" aria-live="polite">
          {feedback ?? currentVerdict.warning}
        </p>
      )}
    </section>
  );
}
