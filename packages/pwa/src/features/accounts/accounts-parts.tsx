/** The small pieces every Accounts panel draws the same way: a tab strip, the field styling and the operations. */

import type {
  AccountId,
  AddSignInRequest,
  AddTwoFactorKeyRequest,
  PutAccountDefaultRequest,
  PutAccountRequest,
  PutSignInRequest,
  SignInId,
  TwoFactorId,
} from '@ferretry/protocol';
import type { ReactNode } from 'react';

/** A write reports whether the daemon took it, so a form clears only then. */
type Took = Promise<boolean>;

/** Everything the screen can ask the daemon to change. Each is a person route and answers whether it took. */
export interface AccountOps {
  readonly putAccount: (id: AccountId, body: PutAccountRequest) => Took;
  readonly removeAccount: (id: AccountId) => Took;
  readonly addSignIn: (id: AccountId, body: AddSignInRequest) => Took;
  readonly putSignIn: (id: SignInId, body: PutSignInRequest) => Took;
  readonly removeSignIn: (id: SignInId) => Took;
  readonly decide: (id: SignInId, proposalId: string, decision: 'approve' | 'decline') => Took;
  readonly addKey: (id: AccountId, body: AddTwoFactorKeyRequest) => Took;
  readonly removeKey: (id: AccountId, key: TwoFactorId) => Took;
  readonly merge: (keep: AccountId, from: AccountId) => Took;
  readonly apart: (one: AccountId, other: AccountId) => Took;
  readonly setDefault: (body: PutAccountDefaultRequest) => Took;
}

export const INPUT = 'kt-input min-h-[44px] w-full rounded-control border border-border bg-surface-2 px-2 text-fg';

export interface TabSpec<Id extends string> {
  readonly id: Id;
  readonly label: string;
}

export function Tabs<Id extends string>({
  label,
  tabs,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly tabs: readonly TabSpec<Id>[];
  readonly selected: Id;
  readonly onSelect: (id: Id) => void;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-wrap gap-1" role="tablist" aria-label={label}>
      {tabs.map(tab => (
        <button
          key={tab.id}
          aria-selected={tab.id === selected}
          className="kt-tab min-h-[44px]"
          data-accounts-tab={tab.id}
          onClick={() => onSelect(tab.id)}
          role="tab"
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** A refusal the daemon gave to the action on this panel. */
export function Refusal({ error }: { readonly error: string | null }): ReactNode {
  return error === null ? null : (
    <p className="m-0 text-ui text-err" data-accounts-error="" role="alert">
      {error}
    </p>
  );
}
