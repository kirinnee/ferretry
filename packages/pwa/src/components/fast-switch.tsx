/**
 * The FAST MODE switch — one small ⚡ control for the composer's chip row and the New session form.
 *
 * Fast mode is a switch, not a level: it is on or it is off, so it reads as a pressed button
 * (`aria-pressed`) rather than a picker that opens a dialog. This file is only the control. What it
 * means (the harness's own fast mode, which may cost more) and when it may be pressed live in the two
 * hosts: `composer-fast.tsx` switches a running session and waits for the harness to confirm, and the
 * New session form just records the choice for the launch.
 *
 * The glyph is filled while the mode is on so the state does not depend on colour alone, and the
 * label is the word "fast" in both states — the pressed state is what changes, not the name.
 */

import { Zap } from 'lucide-react';
import { cn } from '../lib/class-names.ts';

/** What a switch that has not settled appends, on screen and aloud. */
export type FastSwitchMark = 'switching' | 'unconfirmed' | 'failed';

const MARKS: Readonly<
  Record<FastSwitchMark, { readonly text: string; readonly aria: string; readonly title: string }>
> = {
  switching: { text: '· switching…', aria: ', switching', title: 'Switching — waiting for the harness to confirm' },
  failed: { text: '· failed', aria: ', the switch failed', title: 'The switch failed' },
  unconfirmed: {
    text: '· unconfirmed',
    aria: ', could not confirm the switch; showing the last reported value',
    title: 'Couldn’t confirm the switch — showing the last value the harness reported',
  },
};

export interface FastSwitchProps {
  readonly id?: string;
  /** Whether fast mode is on, as far as the host knows. */
  readonly pressed: boolean;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  /** Why it cannot be pressed — spoken, and the tooltip. Read-only, finished, busy, or a model with no fast mode. */
  readonly disabledReason?: string;
  /** The id of a node carrying `disabledReason` for assistive tech. */
  readonly reasonId?: string;
  /** A switch in flight or given up on; absent when settled. */
  readonly mark?: FastSwitchMark;
  /** The sentence behind a mark — a failure's reason — shown on hover in place of the mark's generic title. */
  readonly detail?: string;
  /** Spoken purpose, e.g. "Fast mode". The state and any mark are appended. */
  readonly ariaLabel?: string;
  readonly title?: string;
  readonly className?: string;
  /** `chip` matches the composer's mono chips; `field` is a form control with a visible border. */
  readonly variant?: 'chip' | 'field';
}

export function FastSwitch({
  id,
  pressed,
  onPress,
  disabled = false,
  disabledReason,
  reasonId,
  mark,
  detail,
  ariaLabel = 'Fast mode',
  title = 'Fast mode — faster output; can cost more',
  className,
  variant = 'chip',
}: FastSwitchProps) {
  const marked = mark === undefined ? undefined : MARKS[mark];
  return (
    <button
      aria-describedby={disabledReason !== undefined && reasonId !== undefined ? reasonId : undefined}
      aria-disabled={disabled}
      aria-label={`${ariaLabel}${marked?.aria ?? ''}`}
      aria-pressed={pressed}
      className={cn(
        'mono inline-flex shrink-0 items-center gap-xs rounded-control text-chrome',
        variant === 'chip' ? 'min-w-[44px] px-1' : 'border border-border-strong px-2 py-1',
        pressed ? 'text-accent' : 'text-fg-soft hover:text-accent',
        'disabled:cursor-not-allowed disabled:hover:text-fg-soft',
        className,
      )}
      data-fast-switch={pressed ? 'on' : 'off'}
      disabled={disabled}
      id={id}
      onClick={onPress}
      title={disabledReason ?? detail ?? marked?.title ?? title}
      type="button"
    >
      <Zap aria-hidden="true" className={cn('shrink-0', pressed ? 'fill-current' : undefined)} size={11} />
      <span>fast</span>
      {marked ? (
        <span aria-hidden="true" className="shrink-0 not-italic text-faint" data-switch-state={mark}>
          {marked.text}
        </span>
      ) : null}
    </button>
  );
}
