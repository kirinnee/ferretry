/**
 * "Set up automatic codes", under a code card (docs/input-requests.md, "Set up automatic codes").
 *
 * The owner pastes a 2FA key (the base32 secret or its otpauth:// link) so Ferretry can make the codes. What the page
 * does, in order: reads the paste as the owner types (`readSeedDraft`: instant feedback, nothing sent); on Save sends
 * it ONCE, padded, to be STAGED in the daemon's memory; clears the field at that instant; asks for a passkey bound to
 * that one stage; only then commits it. A dismissed passkey drops the stage and nothing is saved.
 *
 * The key lives in this component's field and nowhere else: never in state (the field is the shared uncontrolled
 * `SecretInput`, so it is not in the input's `value` attribute either; each render reads it through the ref to say what
 * it reads as), never in a URL, a log or storage, and the field clears when the page is hidden. Every sentence here is the app's or the daemon's words about
 * the owner's own account; nothing a ferret wrote is drawn.
 */

import { LOGIN_TOTP_WARNING, padInputValue, type TwoFactorStageId } from '../../../contract/routes/index.ts';
import { type ReactNode, useId, useState } from 'react';
import { SecretInput, SelectBox, useSecretField } from '@ferretry/app/ui';
import { SelectField } from '../accounts/accounts-parts.tsx';
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
import { type AccountsClient as InputClient, commitSeed, dropSeed, stageSeed } from '../accounts/accounts-api.ts';

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
  const seed = useSecretField();
  const seedId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const [accountId, setAccountId] = useState(initial?.id);
  const [label, setLabel] = useState('');
  const [warningTick, setWarningTick] = useState(false);
  const [mismatchTick, setMismatchTick] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });

  const account = accounts.find(each => each.id === accountId);
  const draft = readSeedDraft(seed.read(), account);
  const busy = phase.kind === 'staging' || phase.kind === 'passkey' || phase.kind === 'saving';
  const blocked = saveBlocked({ draft, account, warningTick, mismatchTick, busy });

  // The field empties itself when the page is hidden (the shared hook); these are the other two: sent, and closed.
  const clearKey = seed.clear;

  const save = async (): Promise<void> => {
    if (account === undefined || blocked !== undefined) return;
    setPhase({ kind: 'staging' });
    let staged: TwoFactorStageId | undefined;
    try {
      const answer = await stageSeed(client, account.id, {
        padded: padInputValue(seed.read()),
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
              <SelectField
                className="flex min-w-0 flex-col gap-1 text-meta text-muted"
                label="Which account is this key for?"
              >
                {id => (
                  <SelectBox
                    id={id}
                    className="min-h-[44px] w-full min-w-0 rounded-control border border-border bg-surface-2 px-2 text-fg"
                    disabled={busy}
                    label="Which account is this key for?"
                    onChange={next => {
                      setAccountId(accounts.find(each => each.id === next)?.id);
                      setMismatchTick(false);
                    }}
                    options={[
                      { value: '', label: 'Pick one' },
                      ...accounts.map(each => ({ value: each.id, label: accountWords(each) })),
                    ]}
                    value={accountId ?? ''}
                  />
                )}
              </SelectField>
            ) : null}

            <label className="flex min-w-0 flex-col gap-1 text-meta text-muted" htmlFor={seedId}>
              2FA key or otpauth:// link
              <SecretInput
                id={seedId}
                className="kt-input mono min-h-[44px] rounded-control border border-border bg-surface-2 px-2 text-fg"
                data-codes-seed=""
                disabled={busy}
                field={seed}
                onTyped={() => setMismatchTick(false)}
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
                className="flex min-w-0 flex-col gap-2 rounded-panel border border-warn p-panel"
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
