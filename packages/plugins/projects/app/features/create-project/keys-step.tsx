/**
 * STEP 4: PUSH AND SIGNING, for each linked account that has no key yet. One press makes the key on the daemon and
 * registers its public half at GitHub; the private half never reaches this screen. A refusal is shown as worded.
 */
import { StepPageFrame, type StepProgressProps } from '@ferretry/app';
import { ConfirmToSee } from '@ferretry/app/ui';
import { Check, KeyRound, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { ProjectsClient } from '../../lib/client.ts';
import { reasonOf } from '../../lib/client.ts';
import { accountHasKeys, setUpKeys } from './accounts-api.ts';
import type { GitAccountsState } from './use-git-accounts.ts';

type KeyState =
  | { readonly phase: 'working' }
  | { readonly phase: 'done'; readonly fingerprint: string }
  | { readonly phase: 'refused'; readonly message: string };

export interface KeysStepProps {
  readonly client: ProjectsClient;
  /** The connected accounts as the machine last showed them: `accounts.accounts` is `null` until that read succeeds. */
  readonly accounts: GitAccountsState;
  /** The ids of the accounts this project was just linked to. */
  readonly linked: readonly string[];
  readonly progress: StepProgressProps;
  readonly onNext: () => void;
}

export function KeysStep({ client, accounts: read, linked, progress, onNext }: KeysStepProps) {
  const [states, setStates] = useState<Readonly<Record<string, KeyState>>>({});
  // An unread list proves nothing: "no key found" and "not checked yet" are different answers, and only a list says which.
  const checked = read.accounts !== null;
  const accounts = (read.accounts ?? []).filter(account => linked.includes(account.id));
  const needing = accounts.filter(account => !accountHasKeys(account));
  const keyed = accounts.filter(accountHasKeys);
  const put = (id: string, state: KeyState): void => setStates(current => ({ ...current, [id]: state }));
  const run = (id: string): void => {
    put(id, { phase: 'working' });
    void setUpKeys(client, id).then(
      answer => put(id, { phase: 'done', fingerprint: answer.fingerprint }),
      (cause: unknown) => put(id, { phase: 'refused', message: reasonOf(cause) }),
    );
  };
  const busy = Object.values(states).some(state => state.phase === 'working');

  return (
    <StepPageFrame
      title="Push and signing"
      line="So ferrets in this project can push and sign commits as the accounts you linked."
      progress={progress}
      next={{ label: needing.length === 0 ? 'Next' : 'Continue', disabled: busy, onClick: onNext }}
    >
      <div className="grid min-w-0 gap-md" data-create-step="keys">
        {!checked ? (
          <div data-create-keys="unchecked">
            <ConfirmToSee
              line="Not checked yet: this machine has not shown its GitHub accounts, so whether they have a key is unknown. Confirm to check."
              onConfirm={read.confirm}
            />
          </div>
        ) : needing.length === 0 ? (
          <p className="m-0 text-meta text-muted" data-create-keys="none">
            Every linked account already has a key on this machine, so ferrets here can push and sign as them.
          </p>
        ) : (
          <>
            <p className="m-0 max-w-prose text-meta leading-base text-muted">
              An account with no key cannot push or sign commits from here. Setting one up makes an SSH key on this
              machine, used for both pushing and signing, and adds its public half to the account on GitHub. The private
              half never leaves the daemon.
            </p>
            {keyed.length > 0 && (
              <ul className="m-0 grid list-none gap-0.5 p-0 text-meta text-muted" data-create-keys-ready="">
                {keyed.map(account => (
                  <li key={account.id}>@{account.login} already has a key on this machine.</li>
                ))}
              </ul>
            )}
            <ul className="m-0 grid list-none divide-y divide-border-soft p-0">
              {needing.map(account => {
                const state = states[account.id];
                return (
                  <li key={account.id} className="grid min-w-0 gap-1 py-2" data-create-key-account={account.id}>
                    <span className="text-ui font-medium">@{account.login}</span>
                    {state?.phase === 'done' ? (
                      <p className="m-0 flex items-center gap-xs text-meta text-ok" role="status">
                        <Check className="shrink-0" size={14} aria-hidden="true" />
                        <span className="shrink-0 whitespace-nowrap">Key added</span>
                        <span className="mono min-w-0 break-all text-muted">{state.fingerprint}</span>
                      </p>
                    ) : (
                      <div>
                        <button
                          type="button"
                          className="kt-btn min-h-control max-w-full"
                          disabled={state?.phase === 'working'}
                          onClick={() => run(account.id)}
                        >
                          {state?.phase === 'working' ? (
                            <LoaderCircle
                              className="animate-spin motion-reduce:animate-none"
                              size={14}
                              aria-hidden="true"
                            />
                          ) : (
                            <KeyRound size={14} aria-hidden="true" />
                          )}
                          Set up push and signing
                        </button>
                      </div>
                    )}
                    {state?.phase === 'refused' && (
                      <p className="m-0 flex items-start gap-xs text-meta text-err" role="alert">
                        <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
                        {state.message}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </StepPageFrame>
  );
}
