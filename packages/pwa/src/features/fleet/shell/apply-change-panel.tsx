/**
 * The last thing every Machines change shows before it is sent (docs/design/account-model.md §7):
 * the button that makes the change, a plain sentence when this device will be asked for its passkey,
 * and what went wrong as one sentence.
 *
 * `useAccountChanges` is the state behind it — what this browser may change here, whether a change is
 * in flight, and the last refusal — so a tab only says WHICH change to make. The passkey itself is
 * asked for by the carrier when the daemon wants it; nothing here holds or sees a credential.
 */

import type { FleetAccountChange, FleetAccountChangeView } from '@ferretry/protocol';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { grantGuidance } from '../../../lib/grants.ts';
import { Button } from '../../../shell/primitives.tsx';
import type { FleetClientFactory } from '../fleet-client.ts';
import {
  applyAccountChange,
  applyStagedChange,
  type ChangeResult,
  changeRefusalSentence,
  type FleetApplyAuthority,
  readChangeAuthority,
  type StageResult,
  stageAccountChange,
} from './apply-change.ts';
import { type SkippedEntry, skippedFromOutcome } from './skipped-model.ts';

export interface AccountChanges {
  /** `null` while it is being read. */
  readonly authority: FleetApplyAuthority | null;
  readonly busy: boolean;
  /** The last refusal, as one sentence, or `null`. */
  readonly refusal: string | null;
  /** Stage and apply one change. */
  readonly apply: (change: FleetAccountChange) => Promise<ChangeResult>;
  /** Stage only, for a confirm card that shows the daemon's consequences first. */
  readonly stage: (change: FleetAccountChange) => Promise<StageResult>;
  /** Apply a change {@link stage} returned. */
  readonly applyStaged: (staged: FleetAccountChangeView) => Promise<ChangeResult>;
  /** What the last change that landed left as it was: the provisioner's skipped entries, empty when none. */
  readonly skipped: readonly SkippedEntry[];
  /** Forget the last refusal. */
  readonly clear: () => void;
  /** Show a sentence the caller worded (an act's own refusal) where a change's refusal shows. */
  readonly refuse: (sentence: string) => void;
}

export interface UseAccountChangesOptions {
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
}

/** The change state for one machine. A new connection starts over: nothing crosses machines. */
export function useAccountChanges({ connection, createClient }: UseAccountChangesOptions): AccountChanges {
  const [authority, setAuthority] = useState<FleetApplyAuthority | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<readonly SkippedEntry[]>([]);

  useEffect(() => {
    let live = true;
    setAuthority(null);
    setRefusal(null);
    setSkipped([]);
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
    async <R extends ChangeResult | StageResult>(
      work: (client: Awaited<ReturnType<FleetClientFactory>>) => Promise<R>,
    ): Promise<R | Extract<ChangeResult, { kind: 'refused' }>> => {
      setBusy(true);
      setRefusal(null);
      try {
        const result = await work(await createClient(connection));
        if (result.kind === 'refused') setRefusal(result.sentence);
        if (result.kind === 'applied') {
          // Only an apply that landed says what it skipped, so a sign-out or a rollback leaves the last answer be.
          const left = skippedFromOutcome(result.outcome);
          if (left !== null) setSkipped(left);
        }
        return result;
      } catch (error) {
        // Only a client that could not be made lands here (a change's own failure is already a result),
        // and that says why rather than claiming the machine was silent.
        const sentence = changeRefusalSentence(error);
        setRefusal(sentence);
        return { kind: 'refused', sentence };
      } finally {
        setBusy(false);
      }
    },
    [connection, createClient],
  );

  return {
    authority,
    busy,
    refusal,
    skipped,
    apply: change => run(client => applyAccountChange(client, change)),
    stage: change => run(client => stageAccountChange(client, change)),
    applyStaged: staged => run(client => applyStagedChange(client, staged)),
    clear: () => setRefusal(null),
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
  readonly onSubmit: () => void;
  /** Buttons that sit beside the submit button ("Keep signed in"). */
  readonly children?: ReactNode;
  /** Extra classes for the submit button: a label long enough to need two lines on a phone wraps. */
  readonly submitClassName?: string;
}

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
  submitClassName,
}: ChangeApplyPanelProps) {
  const ready = authority !== null && authority.kind !== 'refused' && !disabled && !busy;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ready) onSubmit();
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} data-change-apply={authority?.kind ?? 'reading'}>
      {authority?.kind === 'refused' ? (
        <p role="status" className="m-0 text-cell leading-base text-warn" data-change-grant-refused="">
          {grantGuidance(authority.refusal, 'fleet').explanation}
        </p>
      ) : null}
      {authority?.kind === 'step-up' ? (
        <p className="m-0 text-meta leading-base text-muted" data-change-step-up="">
          {machineName} will ask you to confirm with your passkey when you save.
        </p>
      ) : null}
      {refusal === null ? null : (
        <p role="alert" className="m-0 text-cell leading-base text-err" data-change-refusal="">
          {refusal}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={variant} disabled={!ready} className={submitClassName} data-change-submit="">
          {busy ? busyLabel : submitLabel}
        </Button>
        {children}
      </div>
    </form>
  );
}
