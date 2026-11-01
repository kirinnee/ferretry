/** How a sign-in goes: the method, an SSO provider's name, the provider account it goes via, and (new site) its domains. */

import { type AccountSummary, LOGIN_SSO_NAME_MAX_LENGTH, type LoginMethodKind } from '@ferretry/protocol';
import type { ReactNode } from 'react';
import { METHOD_OPTIONS, type SignInDraft } from '../../lib/login-form.ts';
import { INPUT } from './accounts-parts.tsx';

export function MethodFields({
  draft,
  onChange,
  providers,
  disabled,
  withDomains,
}: {
  readonly draft: SignInDraft;
  readonly onChange: (next: SignInDraft) => void;
  /** The other accounts a provider method may go via. */
  readonly providers: readonly Pick<AccountSummary, 'id' | 'label' | 'username'>[];
  readonly disabled: boolean;
  readonly withDomains: boolean;
}): ReactNode {
  return (
    <>
      {withDomains ? (
        <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
          Login domains
          <input
            autoCapitalize="off"
            autoComplete="off"
            className={INPUT}
            data-accounts-domains=""
            disabled={disabled}
            onChange={event => onChange({ ...draft, domains: event.target.value })}
            placeholder="app.vercel.com, accounts.google.com"
            spellCheck={false}
            value={draft.domains}
          />
        </label>
      ) : null}
      <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
        How it signs in
        <select
          className={INPUT}
          data-accounts-method=""
          disabled={disabled}
          onChange={event => onChange({ ...draft, method: event.target.value as LoginMethodKind })}
          value={draft.method}
        >
          {METHOD_OPTIONS.map(option => (
            <option key={option.kind} value={option.kind}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {draft.method === 'sso' ? (
        <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
          SSO provider, as its button says it
          <input
            autoComplete="off"
            className={INPUT}
            data-accounts-sso=""
            disabled={disabled}
            maxLength={LOGIN_SSO_NAME_MAX_LENGTH}
            onChange={event => onChange({ ...draft, ssoName: event.target.value })}
            value={draft.ssoName}
          />
        </label>
      ) : null}
      {draft.method !== 'password' ? (
        <label className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg">
          Through which account
          <select
            className={INPUT}
            data-accounts-via=""
            disabled={disabled}
            onChange={event => onChange({ ...draft, via: event.target.value })}
            value={draft.via}
          >
            <option value="">None: sign in by hand</option>
            {providers.map(provider => (
              <option key={provider.id} value={provider.id}>
                {provider.username === undefined ? provider.label : `${provider.label} · ${provider.username}`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </>
  );
}
