/**
 * THE NEW-SESSION RUNTIME CHOICE: one button per runtime, split Claude and Codex.
 *
 * It replaces the Account combobox on the form that STARTS a session. A person picking where a
 * session runs is choosing among a handful of named things, and a closed box that has to be opened,
 * searched and read row by row is the slow way to do that — on a phone most of all. Here every
 * runtime is on screen under its harness, one tap picks it, and the machine's first usable runtime
 * is already picked.
 *
 * ONE ANSWER ACROSS BOTH GROUPS. Every button is a native radio sharing one `name`, so the browser
 * keeps a single selection across Claude and Codex and gives arrow-key movement and a single Tab stop
 * for free. The wrapping `role="radiogroup"` names the field; the harness groups only label.
 *
 * THE DRAFT STAYS THE SOURCE OF TRUTH. A button writes the runtime's wrapper into the draft, exactly
 * as typing it would, and what is highlighted is read back from that text — so a value this page did
 * not choose (a stale one after a daemon switch) can never leave a highlighted button and a different
 * runtime in the request. When nothing offered matches the text, the first usable runtime (or the one
 * a Launch button named) replaces it. A runtime the roster never mentioned can still be typed, but only
 * where the roster could not be read at all — the one place there is nothing to press.
 *
 * EVERY MISSING FACT STAYS MISSING. A button shows quota only when the cached feed has a row for it
 * and health only when the login's status was read; an unread fact draws nothing rather than
 * "quota —" or "never checked", because on a phone chip those would be noise claiming nothing.
 */

import { Check } from 'lucide-react';
import { type ReactNode, useEffect, useMemo } from 'react';
import { useAccountPickerSlice } from '../hooks/use-account-picker.ts';
import { accountHealthView } from '../lib/account-health-view.ts';
import type { PickerAccount } from '../lib/account-picker-catalog.ts';
import type { DaemonAccountPickerStore } from '../lib/account-picker-store.ts';
import { cn } from '../lib/class-names.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { QuotaReadout } from '../shell/quota-readout.tsx';
import {
  type AccountPickerOption,
  type AccountUsageRow,
  accountLabel,
  accountPickerOptions,
  firstUsableAccountOption,
  fleetHarnessLabel,
  hintedAccountOption,
  sessionCapableAccountOptions,
} from './daemon-picker-model.ts';

/** The harnesses a runtime can drive, in the order their groups are drawn. */
const HARNESS_ORDER = ['claude', 'codex'] as const satisfies readonly PickerAccount['kind'][];

/** The one `name` that makes every button, in either group, a single choice. */
const RADIO_NAME = 'fy-new-session-runtime';

const HEALTH_TONE = {
  ok: 'text-ok',
  bad: 'text-err',
  warn: 'text-warn',
  muted: 'text-faint',
} as const;

/** A runtime the form chose, and the pairing it was chosen on. Never one without the other. */
export interface ChosenRuntime {
  readonly connection: DaemonConnection;
  readonly account: AccountPickerOption;
}

export interface RuntimeButtonsProps {
  readonly store: DaemonAccountPickerStore;
  /** The one daemon whose runtimes this may ever offer. */
  readonly connection: DaemonConnection;
  /** The daemon's CACHED quota rows, joined by wrapper. Rows, not a store: the app already polls them. */
  readonly usage: readonly AccountUsageRow[];
  /** Why the cached quota feed is missing, if it is. Never fails the roster. */
  readonly usageError: string | null;
  /** The typed draft: the wrapper a session would start on. */
  readonly value: string;
  readonly onValueChange: (next: string) => void;
  /** Told which offered runtime the draft names now (or `null`), so the model box can follow it. */
  readonly onChosen: (chosen: ChosenRuntime | null) => void;
  /** Drawn INSTEAD of the buttons when the roster was read and nothing can run a session. */
  readonly noAccounts: ReactNode;
  /** A Launch button's runtime, used only when offered and usable. */
  readonly preferred?: string;
  /** The id the typed fallback input takes, so the field's own label keeps pointing at it. */
  readonly fallbackId: string;
  /** The element naming this field, for the radiogroup. */
  readonly labelId: string;
  readonly fallbackPlaceholder: string;
}

/** The harness groups that have something to show, in a fixed order. A harness with none is not drawn. */
const harnessGroups = (options: readonly AccountPickerOption[]) =>
  HARNESS_ORDER.map(kind => ({
    kind,
    label: fleetHarnessLabel(kind),
    options: options.filter(option => option.kind === kind),
  })).filter(group => group.options.length > 0);

/** What a runtime runs on, in the words a person picks by: its login's catalog, then its default model. */
const runtimeHint = (account: AccountPickerOption): string => {
  const label = accountLabel(account);
  const hint = [label.id, account.modelCatalog?.label, account.defaultModel].filter(part => part != null);
  return hint.length === 0 ? 'default model' : hint.join(' · ');
};

function RuntimeButton({
  account,
  checked,
  now,
  onChoose,
}: {
  readonly account: AccountPickerOption;
  readonly checked: boolean;
  readonly now: number;
  readonly onChoose: () => void;
}): ReactNode {
  const health = account.health === null ? null : accountHealthView(account.health, now);
  const hasQuota = account.quota !== null;
  return (
    <label
      className={cn(
        'flex min-h-control min-w-0 max-w-full cursor-pointer flex-col justify-center gap-0.5 rounded-control border px-control-x py-1.5 text-left transition-colors',
        'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
        checked ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2 hover:border-accent',
        account.available ? null : 'cursor-not-allowed opacity-60 hover:border-border',
      )}
      data-runtime-option={account.wrapper}
      title={account.wrapper}
    >
      <input
        checked={checked}
        className="sr-only"
        disabled={!account.available}
        name={RADIO_NAME}
        onChange={onChoose}
        type="radio"
        value={account.wrapper}
      />
      <span className="flex min-w-0 items-center gap-1">
        {checked ? <Check aria-hidden="true" className="shrink-0 text-accent" size={12} /> : null}
        <span className="min-w-0 break-words text-ui font-semibold text-fg">{account.displayName}</span>
      </span>
      <span className="mono min-w-0 break-words text-meta text-muted">{runtimeHint(account)}</span>
      {hasQuota || health !== null ? (
        <span className="flex flex-wrap items-center gap-x-2 text-2xs">
          <QuotaReadout className="text-2xs" quota={account.quota} />
          {health === null ? null : (
            <span className={cn('mono', HEALTH_TONE[health.tone])} title={health.detail}>
              {health.label.toLowerCase()}
            </span>
          )}
        </span>
      ) : null}
      {account.unavailableReason === null ? null : (
        <span className="text-meta text-warn">{account.unavailableReason}</span>
      )}
    </label>
  );
}

/**
 * The runtime field for a surface that STARTS a session.
 *
 * It subscribes to the roster once and projects everything from that: the manifest, the cached quota
 * rows handed in and the stored health the store hydrates beside it. It reads nothing else and writes
 * only the draft — choosing a button probes no runtime and starts nothing.
 */
export function RuntimeButtons({
  store,
  connection,
  usage,
  usageError,
  value,
  onValueChange,
  onChosen,
  noAccounts,
  preferred,
  fallbackId,
  labelId,
  fallbackPlaceholder,
}: RuntimeButtonsProps): ReactNode {
  const slice = useAccountPickerSlice(store, connection);
  const published = slice.catalog?.accounts ?? null;
  const health = slice.health;
  // Only an agent runtime can run a session; the person's own CLI is published too and is refused.
  const offered = useMemo(
    () => sessionCapableAccountOptions(accountPickerOptions(published, usage, health)),
    [published, usage, health],
  );
  const suggested = hintedAccountOption(offered, preferred) ?? firstUsableAccountOption(offered);
  const selected = useMemo(
    () => offered?.find(option => option.available && option.wrapper === value) ?? null,
    [offered, value],
  );

  // The draft names no runtime this machine offers: fill in the best one, or empty it.
  useEffect(() => {
    if (offered === null || selected !== null) return;
    const next = suggested?.wrapper ?? '';
    if (next !== value) onValueChange(next);
  }, [offered, selected, suggested, value, onValueChange]);

  useEffect(() => {
    onChosen(selected === null ? null : { connection, account: selected });
  }, [selected, connection, onChosen]);

  if (offered === null) {
    if (slice.status !== 'error') {
      return (
        <p className="m-0 text-ui text-muted" role="status">
          Reading this machine’s runtimes…
        </p>
      );
    }
    return (
      <div className="grid gap-xs">
        <input
          className="kt-input w-full font-mono"
          id={fallbackId}
          onChange={event => onValueChange(event.target.value)}
          placeholder={fallbackPlaceholder}
          value={value}
        />
        <p className="m-0 text-meta leading-base text-warn" role="alert">
          {slice.error ?? 'this daemon’s runtimes could not be read'} Type a runtime name instead.
        </p>
      </div>
    );
  }
  if (offered.length === 0) return noAccounts;

  const now = Date.now();
  return (
    <div className="grid gap-xs">
      {/* `relative` is load-bearing: each radio is `sr-only`, which is absolutely positioned, and
          without a positioned ancestor focusing one scrolls the fixed app shell out of view. */}
      <div aria-labelledby={labelId} className="relative mt-1 grid gap-sm" data-runtime-buttons="" role="radiogroup">
        {harnessGroups(offered).map(group => (
          <fieldset className="m-0 grid min-w-0 gap-xs border-0 p-0" data-runtime-group={group.kind} key={group.kind}>
            <legend className="kt-label mb-1 p-0 text-faint">{group.label}</legend>
            <div className="flex flex-wrap gap-sm">
              {group.options.map(account => (
                <RuntimeButton
                  account={account}
                  checked={account.wrapper === selected?.wrapper}
                  key={account.key}
                  now={now}
                  onChoose={() => onValueChange(account.wrapper)}
                />
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      {slice.status === 'error' && slice.error !== null ? (
        <p className="m-0 text-meta leading-base text-warn" role="status">
          {slice.error} The runtimes shown may be out of date.
        </p>
      ) : null}
      {usageError === null ? null : (
        <p className="m-0 text-meta leading-base text-muted" data-picker-advisory="" role="status">
          {usageError} A runtime with no reading shows no quota rather than a percentage.
        </p>
      )}
    </div>
  );
}
