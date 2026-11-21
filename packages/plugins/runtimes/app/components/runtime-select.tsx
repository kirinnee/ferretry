/**
 * THE NEW-SESSION RUNTIME CHOICE: the app's SelectBox, the runtimes grouped under Claude and Codex.
 *
 * The owner asked for one custom list control everywhere ("for dropdown, please use a custom component … on mobile, make it appear in
 * the middle as a modal … like a combo box, where people can type to search"), and New ferret is now the only start form, so
 * its runtime field is that control: a closed box showing the chosen runtime, a drawn list (a search field once it is long, a
 * centred dialog on a phone) with each runtime under its harness, and the machine's first usable runtime already chosen.
 *
 * ONE ANSWER ACROSS BOTH GROUPS. The box holds one value, the runtime's wrapper, across Claude and Codex; the groups only head
 * the list. A runtime that cannot run a session (its login is gone) is listed greyed with the reason, never pickable.
 *
 * THE DRAFT STAYS THE SOURCE OF TRUTH. A pick writes the runtime's wrapper into the draft, exactly as typing it would, and what
 * the box shows is read back from that text — so a value this page did not choose (a stale one after a daemon switch) can never
 * show one runtime and send another. When nothing offered matches the text, the first usable runtime (or the one a Launch
 * button named) replaces it. A runtime the roster never mentioned can still be typed, but only where the roster could not be
 * read at all — the one place there is nothing to pick.
 *
 * EVERY MISSING FACT STAYS MISSING. A runtime's row shows quota only when the cached feed has a row for it and health only when
 * the login's status was read; an unread fact draws nothing rather than "quota —" or "never checked". The chosen runtime's
 * quota and health are also drawn under the box, in their tones, so they are seen without opening the list.
 */

import { Loading, SelectBox, type SelectOption } from '@ferretry/app/ui';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { UsageAccountView } from '@ferretry/plugin-usage/contract';
import { Activity } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useAccountPickerSlice } from '../hooks/use-account-picker.ts';
import { accountHealthView } from '../lib/account-health-view.ts';
import type { PickerAccount } from '../lib/account-picker-catalog.ts';
import type { AccountPickerStore } from '../lib/account-picker-store.ts';
import { quotaParts } from '../lib/quota-text.ts';
import { Button, cn } from '../ui.ts';
import {
  type AccountPickerOption,
  accountLabel,
  accountPickerOptions,
  firstUsableAccountOption,
  fleetHarnessLabel,
  hintedAccountOption,
  sameHarnessAccountOptions,
  sessionCapableAccountOptions,
} from '../lib/daemon-picker-model.ts';

/** The harnesses a runtime can drive, in the order their groups are drawn. */
const HARNESS_ORDER = ['claude-code', 'codex'] as const satisfies readonly PickerAccount['kind'][];

const HEALTH_TONE = {
  ok: 'text-ok',
  bad: 'text-err',
  warn: 'text-warn',
  muted: 'text-faint',
} as const;

const QUOTA_TONE = { muted: 'text-faint', warn: 'text-warn', err: 'text-err' } as const;

/** A runtime the form chose. The client the store reads through belongs to one daemon, so it names no pairing. */
export interface ChosenRuntime {
  readonly account: AccountPickerOption;
}

export interface RuntimeSelectProps {
  /** The roster of the one daemon whose runtimes this may ever offer (the store is made over its client). */
  readonly store: AccountPickerStore;
  /** The client bound to that daemon: the roster is read again when its runtimes move. */
  readonly client: Pick<PluginClient, 'subscribe'>;
  /** The instant the quota readouts are judged against, in epoch milliseconds: the shell's clock, never this file's. */
  readonly now: number;
  /** Usage's quota rows for this daemon, joined by wrapper (empty when Usage is off). */
  readonly usage: readonly UsageAccountView[];
  /** Why the cached quota feed is missing, if it is. Never fails the roster. */
  readonly usageError: string | null;
  /** The typed draft: the wrapper a session would start on. */
  readonly value: string;
  readonly onValueChange: (next: string) => void;
  /** Told which offered runtime the draft names now (or `null`), so the model box can follow it. */
  readonly onChosen: (chosen: ChosenRuntime | null) => void;
  /** Told the wrappers that can run a session now (`null` until the roster is read), whenever they change. */
  readonly onOffered?: (wrappers: readonly string[] | null) => void;
  /** Drawn INSTEAD of the buttons when the roster was read and nothing can run a session. */
  readonly noAccounts: ReactNode;
  /** A Launch button's runtime, used only when offered and usable. */
  readonly preferred?: string;
  /** Narrow the offer to one harness (a move stays within its harness). */
  readonly harness?: PickerAccount['kind'];
  /** Offer "Check now", the one place the host is asked to check each login again. Never done on mount. */
  readonly offerHealthCheck?: boolean;
  /** The id the box (or the typed fallback input) takes, so the page's own label keeps pointing at it. */
  readonly fallbackId: string;
  /** The page's visible label element: the box announces (and titles its dialog with) that text, not a generic word. */
  readonly labelId?: string;
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

/** One runtime as a list row: its name, then the words a person picks by (what it runs on, its quota, its health, why it is off). */
const optionOf = (account: AccountPickerOption, now: number): SelectOption => {
  const health = account.health === null ? null : accountHealthView(account.health, now);
  const parts = [
    runtimeHint(account),
    ...quotaParts(account.quota, now).map(part => part.text),
    ...(health === null ? [] : [health.label.toLowerCase()]),
    ...(account.unavailableReason === null ? [] : [account.unavailableReason]),
  ];
  return {
    value: account.wrapper,
    label: account.displayName,
    hint: parts.join(' · '),
    disabled: !account.available,
  };
};

/** What the chosen runtime's login and quota say, in their tones, under the box. Draws nothing when neither fact is known. */
function ChosenReadout({ account, now }: { readonly account: AccountPickerOption; readonly now: number }): ReactNode {
  const health = account.health === null ? null : accountHealthView(account.health, now);
  const quota = quotaParts(account.quota, now);
  if (quota.length === 0 && health === null) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-2xs" data-runtime-chosen="">
      {quota.map(part => (
        <span
          className={cn('mono shrink-0', QUOTA_TONE[part.tone])}
          data-runtime-quota=""
          key={part.text}
          {...(part.title === undefined ? {} : { title: part.title })}
        >
          {part.text}
        </span>
      ))}
      {health === null ? null : (
        <span className={cn('mono', HEALTH_TONE[health.tone])} title={health.detail}>
          {health.label.toLowerCase()}
        </span>
      )}
    </span>
  );
}

/**
 * The runtime field for a surface that STARTS a session.
 *
 * It subscribes to the roster once and projects everything from that: the manifest, the cached quota
 * rows handed in and the stored health the store hydrates beside it. It reads nothing else and writes
 * only the draft — choosing a button probes no runtime and starts nothing.
 */
/** The words the page's own label shows (New ferret: "Runtime"; Move: "Agent wrapper"), so the box says what the person reads. */
function useVisibleLabel(labelId: string | undefined): string {
  const [text, setText] = useState('Runtime');
  useLayoutEffect(() => {
    const shown = labelId === undefined ? '' : (document.getElementById(labelId)?.textContent ?? '').trim();
    setText(shown === '' ? 'Runtime' : shown);
  }, [labelId]);
  return text;
}

export function RuntimeSelect({
  store,
  client,
  now,
  usage,
  usageError,
  value,
  onValueChange,
  onChosen,
  onOffered,
  noAccounts,
  preferred,
  harness,
  offerHealthCheck = false,
  fallbackId,
  labelId,
  fallbackPlaceholder,
}: RuntimeSelectProps): ReactNode {
  const label = useVisibleLabel(labelId);
  const slice = useAccountPickerSlice(store, client);
  const published = slice.catalog?.accounts ?? null;
  const health = slice.health;
  // Only an agent runtime can run a session; the person's own CLI is published too and is refused.
  const offered = useMemo(() => {
    const capable = sessionCapableAccountOptions(accountPickerOptions(published, usage, health));
    return harness === undefined ? capable : sameHarnessAccountOptions(capable, harness);
  }, [published, usage, health, harness]);
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
    onChosen(selected === null ? null : { account: selected });
  }, [selected, onChosen]);

  // Said as one string so a roster read again with the same runtimes does not tell the page twice.
  // The store keeps its last catalog while it reads again, so a roster is only SETTLED when the slice says it is
  // ready: loading, re-reading after a change event and an error all leave the offer undecided (`null`), never the
  // stale list a page could act on as if it were the machine's current runtimes.
  const settled = slice.status === 'ready';
  const usable =
    offered === null || !settled ? null : offered.filter(option => option.available).map(option => option.wrapper);
  const usableKey = usable === null ? null : JSON.stringify(usable);
  useEffect(() => {
    onOffered?.(usableKey === null ? null : (JSON.parse(usableKey) as string[]));
  }, [usableKey, onOffered]);

  if (offered === null) {
    if (slice.status !== 'error') {
      return <Loading kind="bar" label="Reading this machine’s runtimes…" />;
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

  return (
    <div className="grid gap-xs">
      <div className="grid min-w-0 max-w-sm gap-xs" data-runtime-select="">
        <SelectBox
          className="w-full"
          id={fallbackId}
          label={label}
          onChange={onValueChange}
          options={harnessGroups(offered).flatMap(group =>
            group.options.map(account => ({ ...optionOf(account, now), group: group.label })),
          )}
          placeholder="Choose a runtime"
          value={selected?.wrapper ?? ''}
        />
        {selected === null ? null : <ChosenReadout account={selected} now={now} />}
      </div>
      {offerHealthCheck ? (
        <div className="flex flex-wrap items-center gap-sm" data-picker-health={slice.healthStatus}>
          <Button
            aria-busy={slice.healthStatus === 'loading' || undefined}
            disabled={slice.healthStatus === 'loading'}
            onClick={() => void store.checkHealth().catch(() => undefined)}
            size="sm"
            type="button"
          >
            <Activity aria-hidden="true" className="shrink-0" size={14} />
            {slice.healthStatus === 'loading' ? 'Checking…' : 'Check now'}
          </Button>
          <span className="min-w-0 text-meta leading-base text-muted">
            Checks sign-ins and read-only provider status. It does not ask a model and uses no inference quota.
          </span>
        </div>
      ) : null}
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
