/**
 * The switch on a login or a runtime that turns it off without deleting it (docs/disabling.md).
 *
 * On → tap to ask for an optional reason and how long, then Switch off. Off → tap to switch it back on,
 * at once: switching on is only ever a loosening back to what was there, and switching off is a
 * tightening, so neither asks "are you sure". A runtime that is off because its LOGIN is off cannot be
 * turned on here — the login owns that block — so its switch is locked and links to the login.
 *
 * Ferrets already running on it are never touched; the form says so, and how to move one.
 */

import type { FleetDisabled } from '@ferretry/protocol';
import { useState } from 'react';
import { cn } from '../../../lib/class-names.ts';
import { Button } from '../../../shell/primitives.tsx';
import { runtimeActionRefusal } from '../runtimes/runtime-actions-model.ts';
import { type AccountChanges, ChangeApplyPanel } from './apply-change-panel.tsx';
import {
  BLOCKS_STARTS,
  disableChange,
  disabledDetail,
  type DisableTarget,
  enableChange,
  KEEPS_RUNNING,
  offHeadline,
  REASON_LIMIT,
  reasonProblem,
  switchOwner,
  UNTIL_CHOICES,
  type UntilChoice,
  untilFor,
} from './disable-model.ts';

export interface DisableSwitchProps {
  readonly target: DisableTarget;
  /** The view's `disabled`, or `undefined` when it is on. */
  readonly disabled: FleetDisabled | undefined;
  /** For a runtime: its login, so a block from the login names it and links to it. */
  readonly login?: { readonly id: string; readonly href: string };
  readonly machineName: string;
  readonly online: boolean;
  readonly changes: AccountChanges;
  /** Called after a change applied, to read the machine again. */
  readonly onChanged: () => unknown;
  /** Supplied in tests. */
  readonly now?: () => number;
  /** In a list row: the hints stay on the page and in the form. */
  readonly compact?: boolean;
  readonly className?: string;
}

const targetName = (target: DisableTarget): string => (target.kind === 'login' ? target.id : target.name);

export function DisableSwitch({
  target,
  disabled,
  login,
  machineName,
  online,
  changes,
  onChanged,
  now = Date.now,
  compact = false,
  className,
}: DisableSwitchProps) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [choice, setChoice] = useState<UntilChoice>('forever');
  const [date, setDate] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const name = targetName(target);
  const off = disabled !== undefined;
  const lockedToLogin = off && switchOwner(target, disabled) === 'login';
  const refusal = runtimeActionRefusal(changes.authority);
  const until = untilFor(choice, date, now());
  const why = reasonProblem(reason);
  const id = `disable-${target.kind}-${name}`;

  const toggle = async (): Promise<void> => {
    changes.clear();
    setFailed(null);
    if (!off) {
      setAsking(current => !current);
      return;
    }
    const result = await changes.apply(enableChange(target));
    if (result.kind === 'refused') {
      setFailed(result.sentence);
      return;
    }
    await onChanged();
  };

  const submit = async (): Promise<void> => {
    if (until.kind === 'problem' || why !== null) return;
    const result = await changes.apply(disableChange(target, reason, until.until));
    if (result.kind === 'refused') return;
    setAsking(false);
    setReason('');
    setChoice('forever');
    setDate('');
    await onChanged();
  };

  return (
    <div
      className={cn('flex min-w-0 flex-col gap-2', className)}
      data-disable-switch={name}
      data-disabled-state={off ? 'off' : 'on'}
    >
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={!off}
          aria-label={`${name} is used for new starts`}
          aria-describedby={`${id}-note`}
          disabled={!online || lockedToLogin || refusal !== null}
          title={refusal ?? undefined}
          onClick={() => void toggle()}
          className={cn(
            'inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center gap-2 rounded-control border px-control-x text-ui font-semibold transition-colors',
            off ? 'border-border bg-surface-2 text-muted' : 'border-accent bg-accent-soft text-accent',
            'disabled:cursor-not-allowed disabled:opacity-60',
          )}
          data-disable-toggle=""
        >
          <span
            aria-hidden="true"
            className={cn(
              'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
              off ? 'border-border-strong bg-surface' : 'border-accent bg-accent',
            )}
          >
            <span
              className={cn(
                'absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-fg transition-transform',
                off ? 'translate-x-[2px]' : 'translate-x-[18px]',
              )}
            />
          </span>
          {off ? 'Off' : 'On'}
        </button>
        <span id={`${id}-note`} className="min-w-0 text-cell leading-base" data-disable-note="">
          {off ? (
            <>
              <span className="block font-semibold text-warn" data-disable-headline="">
                {offHeadline(target, disabled, login?.id ?? '')}
              </span>
              <span className="block text-muted" data-disable-detail="">
                {disabledDetail(disabled)}
              </span>
            </>
          ) : (
            <span className="block text-muted">New starts can use it.</span>
          )}
        </span>
      </div>

      {lockedToLogin && login !== undefined ? (
        <p className="m-0 text-meta leading-base text-muted" data-disable-owner="login">
          Turn it back on from the login:{' '}
          <a href={login.href} className="font-semibold text-accent underline" data-disable-login-link="">
            {login.id}
          </a>
          .{compact ? '' : ` ${KEEPS_RUNNING}`}
        </p>
      ) : null}
      {off && !lockedToLogin && !compact ? (
        <p className="m-0 text-meta leading-base text-muted" data-disable-keeps="">
          {KEEPS_RUNNING}
        </p>
      ) : null}
      {refusal === null || compact ? null : (
        <p className="m-0 text-meta leading-base text-warn" data-disable-refused="">
          The switch is locked here: {refusal}
        </p>
      )}
      {failed === null ? null : (
        <p role="alert" className="m-0 text-cell leading-base text-err" data-disable-error="">
          {failed}
        </p>
      )}

      {asking && !off ? (
        <div className="kt-panel flex flex-col gap-3 p-panel" data-disable-form="">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-reason`} className="text-ui font-semibold text-fg">
              Why <span className="font-normal text-faint">(optional)</span>
            </label>
            <input
              id={`${id}-reason`}
              className="kt-input"
              autoComplete="off"
              maxLength={REASON_LIMIT + 50}
              value={reason}
              placeholder="e.g. monthly spend limit reached"
              onChange={event => setReason(event.target.value)}
              data-disable-reason=""
            />
            {why === null ? null : <span className="text-meta text-err">{why}</span>}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-until`} className="text-ui font-semibold text-fg">
              Switch back on
            </label>
            <select
              id={`${id}-until`}
              className="kt-input"
              value={choice}
              onChange={event => setChoice(event.target.value as UntilChoice)}
              data-disable-until=""
            >
              {UNTIL_CHOICES.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {choice === 'date' ? (
              <>
                <input
                  type="date"
                  aria-label="The day it comes back"
                  className="kt-input"
                  value={date}
                  onChange={event => setDate(event.target.value)}
                  data-disable-date=""
                />
                <span className="text-meta text-muted">It comes back at the start of that day, UTC.</span>
              </>
            ) : null}
            {until.kind === 'problem' && (choice !== 'date' || date !== '') ? (
              <span className="text-meta text-err" data-disable-until-problem="">
                {until.message}
              </span>
            ) : null}
          </div>
          <p className="m-0 text-meta leading-base text-muted">
            {BLOCKS_STARTS} {KEEPS_RUNNING}
          </p>
          <ChangeApplyPanel
            machineName={machineName}
            authority={changes.authority}
            busy={changes.busy}
            busyLabel="Switching off…"
            refusal={changes.refusal}
            submitLabel={`Switch off ${name}`}
            disabled={!online || until.kind === 'problem' || why !== null}
            onSubmit={() => void submit()}
          >
            <Button
              type="button"
              data-disable-cancel=""
              onClick={() => {
                changes.clear();
                setAsking(false);
              }}
            >
              Cancel
            </Button>
          </ChangeApplyPanel>
        </div>
      ) : null}
    </div>
  );
}
