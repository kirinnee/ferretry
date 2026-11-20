/** Accounts' list choices over fake data: the Secure copy paste-rule form (writes through a fake route) and the sign-in method fields. */

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AccountSummary,
  PasteRuleCreate,
  PutSignInRequest,
  SignInSummary,
} from '../../../../contract/routes/index.ts';
import { MethodFields } from '../../../../app/features/accounts/method-fields.tsx';
import type { AccountOps } from '../../../../app/features/accounts/accounts-parts.tsx';
import { SiteDetail } from '../../../../app/features/accounts/site-detail.tsx';
import { CopyRulesCard } from '../../../../app/features/secure-copy/copy-rules-card.tsx';
import type { SignInDraft } from '../../../../app/lib/login-form.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

/** Nine fake accounts: more than the select box's search threshold (seven), so the via list is searchable. */
const PROVIDERS = [
  ['Google (personal)', 'me@example.test'],
  ['Google (work)', 'me@work.example.test'],
  ['GitHub (personal)', 'octo'],
  ['GitHub (work)', 'octo-work'],
  ['Microsoft', 'me@corp.example.test'],
  ['Apple', 'me@icloud.example.test'],
  ['Okta', 'me@okta.example.test'],
  ['GitLab', 'tanuki'],
  ['Bitbucket', 'bucket'],
].map(([label, username], index) => ({ id: `ACCOUNT_${String(index)}`, label: label as string, username }));

/** The rule goes to the page's fake route, which the test reads back: the same write the card always made. */
const write = async (rule: PasteRuleCreate): Promise<boolean> => {
  const response = await fetch('/fake/paste-rules', { method: 'POST', body: JSON.stringify(rule) });
  return response.ok;
};

const NOW = '2026-01-01T00:00:00.000Z';

/** The account the real sign-in form below belongs to; its provider choices are the nine others. */
const OWNER_ACCOUNT = {
  id: 'ACCOUNT_OWN',
  label: 'Vercel',
  fields: { password: false },
  factors: [],
  signIns: ['SIGNIN_1'],
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as AccountSummary;

const SIGN_IN = {
  id: 'SIGNIN_1',
  account: 'ACCOUNT_OWN',
  place: { kind: 'site', domains: ['vercel.com'], match: [] },
  method: { kind: 'sso', name: 'Google' },
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as SignInSummary;

/** The real sign-in save goes to the page's fake route: the same `PUT sign-in` body the Accounts screen sends. */
const putSignIn = async (id: string, body: PutSignInRequest): Promise<boolean> => {
  const response = await fetch('/fake/sign-ins', { method: 'POST', body: JSON.stringify({ id, body }) });
  return response.ok;
};

const NO_OPS = { putSignIn } as unknown as AccountOps;

function Scene() {
  const [draft, setDraft] = useState<SignInDraft>({ method: 'sso', ssoName: 'Google', via: '', domains: '' });
  return (
    <div className="flex flex-col gap-6 p-4" style={{ maxWidth: 720 }}>
      <CopyRulesCard onAdd={write} onRemove={() => true} rules={[]} />
      <section className="flex flex-col gap-3" data-method-scene="">
        <MethodFields disabled={false} draft={draft} onChange={setDraft} providers={PROVIDERS} withDomains={false} />
        <output data-via="">{draft.via}</output>
      </section>
      <SiteDetail
        account={OWNER_ACCOUNT}
        accounts={[OWNER_ACCOUNT, ...(PROVIDERS as unknown as AccountSummary[])]}
        busy={false}
        defaults={{ kind: 'pending' }}
        error={null}
        onClosed={() => undefined}
        onTab={() => undefined}
        ops={NO_OPS}
        signIn={SIGN_IN}
        tab="method"
      />
    </div>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
