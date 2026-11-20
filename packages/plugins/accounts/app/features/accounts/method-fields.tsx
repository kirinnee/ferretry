/** How a sign-in goes: the method, an SSO provider's name, the provider account it goes via, and (new site) its domains. */

import {
  type AccountSummary,
  LOGIN_SSO_NAME_MAX_LENGTH,
  type LoginMethodKind,
} from '../../../contract/routes/index.ts';
import { SelectBox } from '@ferretry/app/ui';
import type { ReactNode } from 'react';
import { METHOD_OPTIONS, type SignInDraft } from '../../lib/login-form.ts';
import { INPUT, SelectField } from './accounts-parts.tsx';

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
      <SelectField className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg" label="How it signs in">
        {id => (
          <SelectBox
            id={id}
            className={INPUT}
            disabled={disabled}
            label="How it signs in"
            onChange={next => onChange({ ...draft, method: next as LoginMethodKind })}
            options={METHOD_OPTIONS.map(option => ({ value: option.kind, label: option.label }))}
            value={draft.method}
          />
        )}
      </SelectField>
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
        <SelectField
          className="flex min-w-0 flex-col gap-1 text-cell font-medium text-fg"
          label="Through which account"
        >
          {id => (
            <SelectBox
              id={id}
              className={INPUT}
              disabled={disabled}
              label="Through which account"
              onChange={next => onChange({ ...draft, via: next })}
              options={[
                { value: '', label: 'None: sign in by hand' },
                ...providers.map(provider => ({
                  value: provider.id,
                  label: provider.username === undefined ? provider.label : `${provider.label} · ${provider.username}`,
                })),
              ]}
              value={draft.via}
            />
          )}
        </SelectField>
      ) : null}
    </>
  );
}
