/**
 * THE SNOOZE CONTROL — a small clock button that opens a menu: "1 hour", "4 hours", "Tomorrow 9:00" and
 * "Custom…" (a date-and-time field with a Snooze button). It sits beside the other header controls, never in the
 * answer row. Esc and a click outside close it; ↑ ↓ walk the choices. A time that has passed is refused where the
 * owner typed it. The times are decided in `lib/agenda-snooze.ts`; this only draws them.
 */

import { Clock } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { customSnooze, localInputValue, snoozeChoices } from '../../lib/agenda-snooze.ts';

export interface AgendaSnoozeMenuProps {
  /** Snooze until this instant. */
  readonly onSnooze: (until: string) => void;
  readonly now?: number;
  readonly disabled?: boolean;
  /** The button's own class: the item view's pager and the card header each size it their way. */
  readonly triggerClass: string;
}

const HOUR_MS = 3_600_000;

interface CustomFormProps {
  readonly now: number;
  readonly onSnooze: (until: string) => void;
}

function CustomSnoozeForm({ now, onSnooze }: CustomFormProps) {
  const [value, setValue] = useState(() => localInputValue(now + HOUR_MS));
  const [problem, setProblem] = useState<string | null>(null);
  const fieldId = useId();
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const parsed = customSnooze(value, Date.now());
    if (parsed.ok) onSnooze(parsed.until);
    else setProblem(parsed.message);
  };
  return (
    <form className="fy-snooze__custom" data-snooze-custom="" noValidate onSubmit={submit}>
      <label className="fy-snooze__label" htmlFor={fieldId}>
        Snooze until
      </label>
      <input
        aria-describedby={problem === null ? undefined : `${fieldId}-problem`}
        aria-invalid={problem === null ? undefined : true}
        className="fy-snooze__field"
        id={fieldId}
        min={localInputValue(now)}
        onChange={event => {
          setValue(event.target.value);
          setProblem(null);
        }}
        type="datetime-local"
        value={value}
      />
      {problem === null ? null : (
        <p className="fy-snooze__problem" id={`${fieldId}-problem`} role="alert">
          {problem}
        </p>
      )}
      <button className="fy-snooze__go" type="submit">
        Snooze
      </button>
    </form>
  );
}

const itemsOf = (root: HTMLElement | null): HTMLElement[] =>
  root === null ? [] : [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')];

export function AgendaSnoozeMenu({ onSnooze, now, disabled = false, triggerClass }: AgendaSnoozeMenuProps) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const close = (refocus: boolean): void => {
    setOpen(false);
    setCustom(false);
    if (refocus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    itemsOf(list.current)[0]?.focus();
    const onPointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) {
        setOpen(false);
        setCustom(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = itemsOf(list.current);
    const at = items.findIndex(item => item === document.activeElement);
    if (at < 0) return;
    event.preventDefault();
    items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };

  const at = now ?? Date.now();
  const snooze = (until: string): void => {
    close(false);
    onSnooze(until);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys are the menu's own; the controls inside are real buttons
    <div className="fy-snooze" onKeyDown={onKeyDown} ref={root}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Snooze this agenda item"
        className={triggerClass}
        data-agenda-snooze=""
        disabled={disabled}
        onClick={() => (open ? close(false) : setOpen(true))}
        ref={trigger}
        title="Snooze"
        type="button"
      >
        <Clock aria-hidden="true" size={18} />
      </button>
      {open ? (
        <div className="fy-snooze__popover" id={menuId}>
          <div aria-label="Snooze for" className="fy-snooze__list" ref={list} role="menu">
            {snoozeChoices(at).map(choice => (
              <button
                className="fy-snooze__item"
                key={choice.id}
                onClick={() => snooze(choice.until)}
                role="menuitem"
                type="button"
              >
                {choice.label}
              </button>
            ))}
            <button
              aria-expanded={custom}
              className="fy-snooze__item"
              onClick={() => setCustom(shown => !shown)}
              role="menuitem"
              type="button"
            >
              Custom…
            </button>
          </div>
          {custom ? <CustomSnoozeForm now={at} onSnooze={snooze} /> : null}
        </div>
      ) : null}
    </div>
  );
}
