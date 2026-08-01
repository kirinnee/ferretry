import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
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

/** A key-capture control which saves only after matching keydown and keyup. */
export function DictationShortcutPicker({ binding, onChange }: DictationShortcutPickerProps) {
  const [capturing, setCapturing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [tone, setTone] = useState<'muted' | 'warn' | 'ok'>('muted');
  const pending = useRef<PendingShortcut | null>(null);

  useEffect(() => (capturing ? beginDictationShortcutCapture() : undefined), [capturing]);

  const cancel = (message = 'Shortcut capture cancelled.'): void => {
    pending.current = null;
    setCapturing(false);
    setTone('muted');
    setFeedback(message);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (event.key === 'Escape') {
      cancel();
      return;
    }
    const candidate = dictationShortcutFromEvent(event.nativeEvent);
    pending.current = { binding: candidate, verdict: validateDictationShortcut(candidate) };
    setTone('muted');
    setFeedback(`Release ${dictationShortcutLabel(candidate)} to test and confirm it.`);
  };
  const onKeyUp = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    const candidate = pending.current;
    if (!candidate || !sameDictationShortcutTrigger(candidate.binding, event.nativeEvent)) return;
    pending.current = null;
    if (!candidate.verdict.ok) {
      setTone('warn');
      setFeedback(candidate.verdict.reason ?? 'That shortcut cannot be used here. Try another.');
      return;
    }
    onChange(candidate.binding);
    setCapturing(false);
    setTone(candidate.verdict.warning ? 'warn' : 'ok');
    setFeedback(candidate.verdict.warning ?? `${dictationShortcutLabel(candidate.binding)} saved.`);
  };
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
        The bounded on-device settle and one enhancement pass insert at your current caret. The shortcut never sends the
        message. On a phone, use the mic button—the keyboard shortcut is optional.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={capturing ? 'primary' : 'outline'}
          className="min-h-[44px] min-w-[44px]"
          aria-pressed={capturing}
          onClick={() => {
            if (capturing) cancel();
            else {
              pending.current = null;
              setTone('muted');
              setFeedback('Press your shortcut, then release its main key. Escape cancels.');
              setCapturing(true);
            }
          }}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={() => {
            if (capturing)
              cancel(
                pending.current
                  ? 'The browser or operating system took focus before keyup, so that chord cannot be trusted here.'
                  : 'Shortcut capture cancelled.',
              );
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
