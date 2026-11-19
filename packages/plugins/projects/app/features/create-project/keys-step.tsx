/**
 * STEP 4: PUSH AND SIGNING, for each linked account that has no key yet. One press makes the key on the daemon and
 * registers its public half at GitHub; the private half never reaches this screen. A refusal is shown as worded.
 */
import { Check, KeyRound, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { ProjectsClient } from '../../lib/client.ts';
import { reasonOf } from '../../lib/client.ts';
import { accountHasKeys, type GitAccountRow, setUpKeys } from './accounts-api.ts';

type KeyState =
  | { readonly phase: 'working' }
  | { readonly phase: 'done'; readonly fingerprint: string }
  | { readonly phase: 'refused'; readonly message: string };

export interface KeysStepProps {
  readonly client: ProjectsClient;
  /** The linked accounts that exist now. */
  readonly accounts: readonly GitAccountRow[];
  readonly onNext: () => void;
}

export function KeysStep({ client, accounts, onNext }: KeysStepProps) {
  const [states, setStates] = useState<Readonly<Record<string, KeyState>>>({});
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
    <div className="grid min-w-0 gap-md" data-create-step="keys">
      {needing.length === 0 ? (
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
          <ul className="m-0 grid list-none gap-xs p-0">
            {needing.map(account => {
              const state = states[account.id];
              return (
                <li
                  key={account.id}
                  className="grid min-w-0 gap-1 rounded-control border border-border-soft bg-surface-2 px-control-x py-2"
                  data-create-key-account={account.id}
                >
                  <span className="text-ui font-medium">@{account.login}</span>
                  {state?.phase === 'done' ? (
                    <p className="m-0 flex items-center gap-xs text-meta text-ok" role="status">
                      <Check size={14} aria-hidden="true" />
                      Key added <span className="mono break-all text-muted">{state.fingerprint}</span>
                    </p>
                  ) : (
                    <div>
                      <button
                        type="button"
                        className="kt-btn h-auto min-h-control max-w-full whitespace-normal py-1 text-left"
                        style={{ height: 'auto', whiteSpace: 'normal' }}
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
                        Set up push and signing for this account
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
      <div>
        <button type="button" className="kt-btn min-h-control" data-variant="primary" disabled={busy} onClick={onNext}>
          {needing.length === 0 ? 'Next' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
