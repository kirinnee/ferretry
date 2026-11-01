import {
  type AccountHint,
  type AccountHintList,
  type AccountList,
  type AccountSummary,
  type AccountDefaultsFile,
  accountDefaultLines,
  accountDefaultScopeWords,
  accountHintLine,
  accountHintSummary,
  LOGIN_HINT_PASSKEYS_OFF,
  loginMethodSentence,
  observedWords,
  type Place,
  placeWords,
  recipeDiffText,
  type SignInSummary,
  type TwoFactorKeySummary,
} from '@ferretry/protocol';

const mark = (present: boolean): string => (present ? '✓' : '–');

/** What an account holds, as names: which secret fields exist, never what they contain. */
function fieldsWords(account: AccountSummary): string {
  return `password ${mark(account.fields.password)}  2FA codes made here ${mark(account.fields.totp)}`;
}

/** Where a sign-in happens, in full: a site's login hosts and what it is for, or a terminal's tool and machine. */
function placeDetail(place: Place): string {
  if (place.kind === 'terminal')
    return `terminal ${place.tool}@${place.dest ?? place.host}${place.dest === undefined ? '' : ` (from ${place.host})`}`;
  const parts = [
    ...(place.domains.length === 0 ? [] : [`signs in on ${place.domains.join(', ')}`]),
    ...(place.match.length === 0 ? [] : [`for ${place.match.join(', ')}`]),
  ];
  return `site ${parts.join(', ')}`;
}

/** How a sign-in goes, naming the provider's account by its label when the daemon said it. */
function methodWords(signIn: SignInSummary): string {
  return loginMethodSentence(signIn.method, signIn.via?.account.label);
}

/** One sign-in on one line: its id, what it does and where. */
export function renderSignInLine(signIn: SignInSummary): string {
  const recipe = signIn.recipe === undefined ? '' : `  [recipe${signIn.recipeBy === 'ferret' ? ' by a ferret' : ''}]`;
  const waiting =
    signIn.proposals === undefined || signIn.proposals.length === 0
      ? ''
      : `  [${String(signIn.proposals.length)} proposal${signIn.proposals.length === 1 ? '' : 's'} waiting]`;
  return `${signIn.id}  ${methodWords(signIn)}, ${placeDetail(signIn.place)}${recipe}${waiting}`;
}

/** A 2FA key in the owner's words: what it is, whether Ferretry makes its codes, and whether that worked. */
export function renderFactorLine(key: TwoFactorKeySummary): string {
  const detail = (() => {
    switch (key.kind) {
      case 'totp': {
        if (!key.automatic) return 'authenticator app: you type its codes';
        if (key.verified === undefined) return 'authenticator app: Ferretry makes the codes (not tried yet)';
        return `authenticator app: Ferretry makes the codes (${key.verified.worked ? 'worked' : 'did NOT work'} ${key.verified.at.slice(0, 10)})`;
      }
      case 'sms':
        return `text message${key.endsWith === undefined ? '' : ` ending ••${key.endsWith}`}: you type the code`;
      case 'email':
        return `email${key.to === undefined ? '' : ` to ${key.to}`}: you type the code`;
      case 'push':
        return `approve on your phone${key.app === undefined ? '' : ` (${key.app})`}`;
      case 'security-key':
        return 'security key: you tap it';
    }
  })();
  return `${key.id}  ${key.label}  (${detail})`;
}

/** The listing: each account with its fields, its 2FA keys and its sign-ins (by `si_` id, the handle every verb takes). */
export function renderAccountList(list: AccountList): string {
  if (list.health === 'damaged')
    return [
      'This daemon cannot read its secret store, so its accounts cannot be listed.',
      list.diagnosis ?? 'no diagnosis was given',
      '',
      'They are NOT gone. Do not add or edit any until the store is readable, or you may write over accounts that are still there.',
    ].join('\n');
  if (list.accounts.length === 0) return 'No accounts on this daemon.';
  const byId = new Map(list.signIns.map(signIn => [signIn.id, signIn]));
  return list.accounts
    .map(account =>
      [
        `${account.label}  [${account.id}]`,
        ...(account.username === undefined ? [] : [`    username: ${account.username}`]),
        `    fields: ${fieldsWords(account)}`,
        ...(account.factors.length === 0
          ? []
          : ['    2FA keys:', ...account.factors.map(key => `      ${renderFactorLine(key)}`)]),
        ...(account.signIns.length === 0
          ? ['    sign-ins: (none: never offered on any page or terminal)']
          : [
              '    sign-ins:',
              ...account.signIns.map(id => {
                const signIn = byId.get(id);
                return `      ${signIn === undefined ? `${id}  (not in this listing)` : renderSignInLine(signIn)}`;
              }),
            ]),
      ].join('\n'),
    )
    .join('\n');
}

/** The sign-ins of the listing as a flat table, for `site ls`. */
export function renderSignInList(account: AccountSummary | undefined, signIns: readonly SignInSummary[]): string {
  if (signIns.length === 0)
    return account === undefined
      ? 'No sign-ins on this daemon.'
      : `${account.id} has no sign-ins yet (add one with \`account site add\`).`;
  return signIns.map(signIn => `${signIn.account}  ${renderSignInLine(signIn)}`).join('\n');
}

/** The outcome line of an account put, rename or merge. */
export function renderAccountLine(account: AccountSummary): string {
  return `${account.id}  ${account.label}  (${fieldsWords(account)})`;
}

/** `fy account hint`: one entry per sign-in, the words a ferret's `account_hint` reads. */
export function renderAccountHint(hint: AccountHintList): string {
  if (hint.hints.length === 0) return accountHintSummary(hint.site, []);
  const lines = hint.hints.map((entry: AccountHint) => `  ${accountHintLine(entry, hint.site)}`);
  return [`Sign-ins for ${hint.site}:`, ...lines, '', LOGIN_HINT_PASSKEYS_OFF].join('\n');
}

/** `fy account site recipe show`: the owner's steps, what the daemon saw, and each proposal as the change it would make. */
export function renderSignInRecipe(signIn: SignInSummary, account: AccountSummary | undefined): string {
  const seen = signIn.observed ?? [];
  const proposals = signIn.proposals ?? [];
  return [
    `${account?.label ?? signIn.account}  [${signIn.account}]  ${signIn.id}  ${placeWords(signIn.place)}`,
    `auto-apply a ferret's proposal: ${signIn.autoApplyRecipe === true ? 'on' : 'off'}`,
    '',
    signIn.recipe ?? "(no recipe yet: write one with `site recipe set`, or approve a ferret's proposal)",
    '',
    ...(seen.length === 0 ? ['Seen: nothing yet'] : ['Seen:', ...seen.map(row => `  ${observedWords(row)}`)]),
    ...proposals.flatMap(proposal => [
      '',
      `${proposal.id}  ${proposal.proposedAt.slice(0, 10)}`,
      `The ferret says: ${proposal.why}`,
      recipeDiffText(proposal.base, proposal.recipe),
    ]),
  ].join('\n');
}

/** The lines of `account-defaults.yaml` in effect, in the owner's words. */
export function renderDefaults(file: AccountDefaultsFile): string {
  const lines = accountDefaultLines(file);
  if (lines.length === 0) return 'No default accounts are set.';
  return lines.map(line => `${line.key} -> ${line.account}  (${accountDefaultScopeWords(line)})`).join('\n');
}
