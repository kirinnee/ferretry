/**
 * The last thing every Machines change shows before it is sent (docs/design/account-model.md §7):
 * the button that makes the change, the operator password when this browser owes it, and what went
 * wrong as one sentence.
 *
 * `useAccountChanges` is the state behind it — what this browser may change here, the unlock a
 * password minted, whether a change is in flight, and the last refusal — so a tab only says WHICH
 * change to make. The password lives in this panel's own field until the click that spends it, and is
 * cleared before the request settles; it never reaches the hook's state.
 */

import type { FleetAccountChange, FleetAccountChangeView } from '@ferretry/protocol';
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { grantGuidance, type HeldUnlock } from '../../../lib/grants.ts';
import { Button } from '../../../shell/primitives.tsx';
import type { FleetClientFactory } from '../fleet-client.ts';
import {
  type Authorization,
  applyAccountChange,
  applyStagedChange,
  authorizeChange,
  type ChangeResult,
  changeNeedsPassword,
  type FleetApplyAuthority,
  readChangeAuthority,
  type StageResult,
  stageAccountChange,
} from './apply-change.ts';

export interface AccountChanges {
  /** `null` while it is being read. */
  readonly authority: FleetApplyAuthority | null;
  readonly busy: boolean;
  /** The last refusal, as one sentence, or `null`. */
  readonly refusal: string | null;
  /** Stage and apply one change. */
  readonly apply: (change: FleetAccountChange, operatorPassword?: string) => Promise<ChangeResult>;
  /** Stage only, for a confirm card that shows the daemon's consequences first. */
  readonly stage: (change: FleetAccountChange, operatorPassword?: string) => Promise<StageResult>;
  /** Apply a change {@link stage} returned. */
  readonly applyStaged: (staged: FleetAccountChangeView, operatorPassword?: string) => Promise<ChangeResult>;
  /** Forget the last refusal. */
  readonly clear: () => void;
  /**
   * Run one guarded act that is not a staged change (a sign-in start, a Check now) with what it must
   * send. A refusal is shown like any other; the act's own failure is the caller's to word.
   */
  readonly authorize: (operatorPassword?: string) => Promise<Authorization>;
  /** Show a sentence the caller worded (an act's own refusal) where a change's refusal shows. */
  readonly refuse: (sentence: string) => void;
}

export interface UseAccountChangesOptions {
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  /** Supplied in tests. */
  readonly now?: () => number;
}

/** The change state for one machine. A new connection starts over: nothing crosses machines. */
export function useAccountChanges({ connection, createClient, now }: UseAccountChangesOptions): AccountChanges {
  const [authority, setAuthority] = useState<FleetApplyAuthority | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const held = useRef<HeldUnlock | null>(null);

  useEffect(() => {
    let live = true;
    held.current = null;
    setAuthority(null);
    setRefusal(null);
    void createClient(connection)
      .then(client => readChangeAuthority(client))
      .catch((): FleetApplyAuthority => ({ kind: 'unreadable' }))
      .then(next => {
        if (live) setAuthority(next);
      });
    return () => {
      live = false;
    };
  }, [connection, createClient]);

  const run = useCallback(
    async <R extends ChangeResult | StageResult | Authorization>(
      work: (client: Awaited<ReturnType<FleetClientFactory>>, current: FleetApplyAuthority) => Promise<R>,
    ): Promise<R | Extract<ChangeResult, { kind: 'refused' }>> => {
      setBusy(true);
      setRefusal(null);
      try {
        const client = await createClient(connection);
        const current = authority ?? (await readChangeAuthority(client));
        const result = await work(client, current);
        held.current = result.held;
        if (result.kind === 'refused') setRefusal(result.sentence);
        // A password that worked moved this browser past the gate: ask again what it may do now, so the
        // next change does not ask for a password the machine would no longer want.
        if (result.held !== null && current.kind === 'locked')
          setAuthority(await readChangeAuthority(client, result.held.token));
        return result;
      } catch {
        const sentence = 'This machine didn’t answer, so nothing was changed. Check it is awake and try again.';
        setRefusal(sentence);
        return { kind: 'refused', sentence, passwordRejected: false, held: held.current };
      } finally {
        setBusy(false);
      }
    },
    [authority, connection, createClient],
  );

  const attempt = useCallback(
    (current: FleetApplyAuthority, operatorPassword: string | undefined) => ({
      daemonId: connection.daemonId,
      authority: current,
      held: held.current,
      ...(operatorPassword === undefined || operatorPassword === '' ? {} : { operatorPassword }),
      ...(now === undefined ? {} : { now }),
    }),
    [connection.daemonId, now],
  );

  return {
    authority,
    busy,
    refusal,
    apply: (change, password) =>
      run((client, current) => applyAccountChange(client, change, attempt(current, password))),
    stage: (change, password) =>
      run((client, current) => stageAccountChange(client, change, attempt(current, password))),
    applyStaged: (staged, password) =>
      run((client, current) => applyStagedChange(client, staged, attempt(current, password))),
    clear: () => setRefusal(null),
    authorize: password => run((client, current) => authorizeChange(client, attempt(current, password))),
    refuse: sentence => setRefusal(sentence),
  };
}

export interface ChangeApplyPanelProps {
  readonly machineName: string;
  readonly authority: FleetApplyAuthority | null;
  readonly busy: boolean;
  readonly refusal: string | null;
  /** "Create runtime", "Sign out". */
  readonly submitLabel: string;
  /** Shown while busy; defaults to "Saving…". */
  readonly busyLabel?: string;
  readonly variant?: 'primary' | 'danger';
  /** The step's own answer is not ready yet (an invalid name). */
  readonly disabled?: boolean;
  /** Called with the typed password, or `undefined` when none is owed. The field is cleared first. */
  readonly onSubmit: (operatorPassword: string | undefined) => void;
  /** Buttons that sit beside the submit button ("Keep signed in"). */
  readonly children?: ReactNode;
}

/** What the person reads about the password, in plain words. */
const passwordHint = (authority: FleetApplyAuthority, machineName: string): string =>
  authority.kind === 'confirm' || (authority.kind === 'locked' && authority.alsoConfirms)
    ? `You’re not on ${machineName}, so it needs its operator password for this change. It is used once and not stored.`
    : `You’re not on ${machineName}, so it needs its operator password before it accepts changes from here. It is not stored.`;

export function ChangeApplyPanel({
  machineName,
  authority,
  busy,
  refusal,
  submitLabel,
  busyLabel = 'Saving…',
  variant = 'primary',
  disabled = false,
  onSubmit,
  children,
}: ChangeApplyPanelProps) {
  const [password, setPassword] = useState('');
  const fieldId = useId();

  const refusedByGrant = authority?.kind === 'refused';
  const needsPassword = authority !== null && changeNeedsPassword(authority);
  const ready = authority !== null && !refusedByGrant && !disabled && !busy && (!needsPassword || password !== '');

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!ready) return;
    // Cleared before the request settles, so the password never sits in a rendered tree after its click.
    const typed = needsPassword ? password : undefined;
    setPassword('');
    onSubmit(typed);
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} data-change-apply={authority?.kind ?? 'reading'}>
      {authority?.kind === 'refused' ? (
        <p role="status" className="m-0 text-cell leading-base text-warn" data-change-grant-refused="">
          {grantGuidance(authority.refusal, 'fleet').explanation}
        </p>
      ) : null}
      {needsPassword ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId} className="text-ui font-semibold text-fg">
            {machineName} operator password
          </label>
          <input
            id={fieldId}
            type="password"
            className="kt-input"
            autoComplete="off"
            value={password}
            disabled={busy}
            data-change-password=""
            onChange={event => setPassword(event.target.value)}
          />
          <span className="text-meta leading-base text-muted">{passwordHint(authority, machineName)}</span>
        </div>
      ) : null}
      {refusal === null ? null : (
        <p role="alert" className="m-0 text-cell leading-base text-err" data-change-refusal="">
          {refusal}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={variant} disabled={!ready} data-change-submit="">
          {busy ? busyLabel : submitLabel}
        </Button>
        {children}
      </div>
    </form>
  );
}
