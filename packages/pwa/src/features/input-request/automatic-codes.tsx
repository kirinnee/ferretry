/**
 * "Set up automatic codes", under a code card (docs/input-requests.md, "Set up automatic codes").
 *
 * The owner pastes a 2FA key (the base32 secret or its otpauth:// link) so Ferretry can make the codes. What the page
 * does, in order: reads the paste as the owner types (`readSeedDraft`: instant feedback, nothing sent); on Save sends
 * it ONCE, padded, to be STAGED in the daemon's memory; clears the field at that instant; asks for a passkey bound to
 * that one stage; only then commits it. A dismissed passkey drops the stage and nothing is saved.
 *
 * The key lives in this component's field and nowhere else: never in state after staging, never in a URL, a log or
 * storage, and the field clears when the page is hidden. Every sentence here is the app's or the daemon's words about
 * the owner's own account; nothing a ferret wrote is drawn.
 */

import { LOGIN_TOTP_WARNING, padInputValue, type TwoFactorStageId } from '@ferretry/protocol';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  accountWords,
  addKeyActWords,
  type CodesAccount,
  DISMISSED_WORDS,
  panelHeading,
  readSeedDraft,
  saveBlocked,
  savedSeedWords,
  seedFailureWords,
  stageTicks,
} from '../../lib/automatic-codes.ts';
import { commitSeed, dropSeed, type InputClient, stageSeed } from '../../lib/input-api.ts';

type Phase =
  | { readonly kind: 'form' }
  | { readonly kind: 'staging' }
  | { readonly kind: 'passkey' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly words: string }
  | { readonly kind: 'failed'; readonly words: string };

export interface AutomaticCodesPanelProps {
  readonly client: InputClient;
  /**
   * The card this is set up from: the daemon refuses the stage unless the account is the one it matched for it. Absent
   * when the owner sets it up from Settings › Accounts, where the account is their own pick and nothing is typed anywhere.
   */
  readonly requestId?: string;
  /** Starts open: the Accounts screen's 2FA keys tab is already the place for it. */
  readonly defaultOpen?: boolean;
  readonly accounts: readonly CodesAccount[];
  readonly initial: CodesAccount | undefined;
  /** Asks for the passkey bound to this stage; `true` only when it was given. */
  readonly addKey: (stage: TwoFactorStageId, words: string) => Promise<boolean>;
  /** The key is saved: the host reads the card and the accounts again (the daemon may have typed the first code). */
  readonly onSaved: () => void;
}

export function AutomaticCodesPanel({
  client,
  requestId,
  defaultOpen = false,
  accounts,
  initial,
  addKey,
  onSaved,
}: AutomaticCodesPanelProps): ReactNode {
  const field = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [accountId, setAccountId] = useState(initial?.id);
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const [warningTick, setWarningTick] = useState(false);
  const [mismatchTick, setMismatchTick] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });

  const account = accounts.find(each => each.id === accountId);
  const draft = readSeedDraft(text, account);
  const busy = phase.kind === 'staging' || phase.kind === 'passkey' || phase.kind === 'saving';
  const blocked = saveBlocked({ draft, account, warningTick, mismatchTick, busy });

  const clearKey = useCallback((): void => {
    setText('');
    if (field.current !== null) field.current.value = '';
  }, []);

  useEffect(() => {
    const hide = (): void => {
      if (document.visibilityState === 'hidden') clearKey();
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
  }, [clearKey]);

  const save = async (): Promise<void> => {
    if (account === undefined || blocked !== undefined) return;
    setPhase({ kind: 'staging' });
    let staged: TwoFactorStageId | undefined;
    try {
      const answer = await stageSeed(client, account.id, {
        padded: padInputValue(text),
        ...(label.trim() === '' ? {} : { label: label.trim() }),
        totpAcknowledged: true,
        ...stageTicks({ draft, mismatchTick }),
        ...(requestId === undefined ? {} : { request: requestId }),
      });
      staged = answer.stage;
      clearKey();
    } catch (cause) {
      clearKey();
      setPhase({ kind: 'failed', words: seedFailureWords(cause) });
      return;
    }
    setPhase({ kind: 'passkey' });
    try {
      if (!(await addKey(staged, addKeyActWords(account)))) {
        await dropSeed(client, account.id, staged).catch(() => undefined);
        setPhase({ kind: 'failed', words: DISMISSED_WORDS });
        return;
      }
      setPhase({ kind: 'saving' });
      const saved = await commitSeed(client, account.id, staged);
      setWarningTick(false);
      setMismatchTick(false);
      setLabel('');
      setPhase({ kind: 'saved', words: savedSeedWords(saved, account.label) });
      onSaved();
    } catch (cause) {
      await dropSeed(client, account.id, staged).catch(() => undefined);
      setPhase({ kind: 'failed', words: seedFailureWords(cause) });
    }
  };

  const again = (): void => {
    setWarningTick(false);
    setMismatchTick(false);
    setPhase({ kind: 'form' });
  };

  return (
    <details
      className="min-w-0"
      data-codes-panel=""
      data-codes-state={phase.kind === 'form' ? draft.kind : phase.kind}
      onToggle={event => {
        const nowOpen = (event.currentTarget as HTMLDetailsElement).open;
        setOpen(nowOpen);
        if (!nowOpen) clearKey();
      }}
      open={open}
    >
      <summary className="cursor-pointer text-cell text-muted" data-codes-heading="">
        {panelHeading(account)}
      </summary>

      <div className="mt-2 flex min-w-0 flex-col gap-3">
        {phase.kind === 'saved' ? (
          <p className="m-0 text-ui text-ok" data-codes-saved="" role="status">
            {phase.words}
          </p>
        ) : phase.kind === 'failed' ? (
          <>
            <p className="m-0 text-ui text-err" data-codes-failed="" role="alert">
              {phase.words}
            </p>
            <div>
              <button className="kt-btn min-h-[44px]" data-codes-again="" onClick={again} type="button">
                Try again
              </button>
            </div>
          </>
        ) : (
          <>
            {accounts.length > 1 ? (
              <label className="flex min-w-0 flex-col gap-1 text-meta text-muted">
                Which account is this key for?
                <select
                  className="kt-input min-h-[44px] rounded-control border border-border bg-surface-2 px-2 text-fg"
                  data-codes-account=""
                  disabled={busy}
                  onChange={event => {
                    setAccountId(accounts.find(each => each.id === event.target.value)?.id);
                    setMismatchTick(false);
                  }}
                  value={accountId ?? ''}
                >
                  <option value="">Pick one</option>
                  {accounts.map(each => (
                    <option key={each.id} value={each.id}>
                      {accountWords(each)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="flex min-w-0 flex-col gap-1 text-meta text-muted">
              2FA key or otpauth:// link
              <input
                autoCapitalize="off"
                autoComplete="new-password"
                className="kt-input mono min-h-[44px] rounded-control border border-border bg-surface-2 px-2 text-fg"
                data-1p-ignore=""
                data-bwignore=""
                data-codes-seed=""
                data-lpignore="true"
                disabled={busy}
                onChange={event => {
                  setText(event.target.value);
                  setMismatchTick(false);
                }}
                ref={field}
                spellCheck={false}
                type="password"
                value={text}
              />
            </label>

            {draft.kind === 'invalid' ? (
              <p className="m-0 text-meta text-err" data-codes-problem="" role="alert">
                {draft.problem}
              </p>
            ) : null}
            {draft.kind === 'parsed' || draft.kind === 'mismatch' ? (
              <p className="m-0 text-meta text-muted" data-codes-reads="">
                Reads as: {draft.reads}
              </p>
            ) : null}

            {draft.kind === 'mismatch' ? (
              <div
                className="flex min-w-0 flex-col gap-2 rounded-control border border-warn p-2"
                data-codes-mismatch=""
              >
                <p className="m-0 text-cell text-warn">{draft.words}</p>
                <label className="flex items-start gap-2 text-cell text-fg">
                  <input
                    checked={mismatchTick}
                    data-codes-mismatch-tick=""
                    disabled={busy}
                    onChange={event => setMismatchTick(event.target.checked)}
                    type="checkbox"
                  />
                  Save it here anyway
                </label>
              </div>
            ) : null}

            <label className="flex min-w-0 flex-col gap-1 text-meta text-muted">
              Name for this key (optional)
              <input
                autoComplete="off"
                className="kt-input min-h-[44px] rounded-control border border-border bg-surface-2 px-2 text-fg"
                data-codes-label=""
                disabled={busy}
                maxLength={60}
                onChange={event => setLabel(event.target.value)}
                value={label}
              />
            </label>

            <label className="flex items-start gap-2 text-cell text-fg">
              <input
                checked={warningTick}
                data-codes-warning-tick=""
                disabled={busy}
                onChange={event => setWarningTick(event.target.checked)}
                type="checkbox"
              />
              <span data-codes-warning="">{LOGIN_TOTP_WARNING}</span>
            </label>

            {phase.kind === 'passkey' ? (
              <p className="m-0 text-cell text-fg" data-codes-passkey="" role="status">
                Confirm with your passkey to save this key. Nothing is saved until you do.
              </p>
            ) : null}
            {blocked !== undefined && !busy ? (
              <p className="m-0 text-meta text-muted" data-codes-blocked="">
                {blocked}
              </p>
            ) : null}

            <div className="flex justify-end">
              <button
                className="kt-btn min-h-[44px] justify-center"
                data-codes-save=""
                data-variant="primary"
                disabled={blocked !== undefined}
                onClick={() => void save()}
                type="button"
              >
                {phase.kind === 'staging' ? 'Checking…' : phase.kind === 'saving' ? 'Saving…' : 'Save and use'}
              </button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
