import {
  type LoginEntryList,
  type LoginEntrySummary,
  type LoginHintList,
  loginDomainsOf,
  loginHintSummary,
  loginMethodOf,
  loginMethodSentence,
  observedWords,
  recipeDiffText,
} from '@ferretry/protocol';

const mark = (present: boolean): string => (present ? '✓' : '–');

/** What an entry holds, as names: which secret fields exist, never what they contain. */
function renderLoginEntryFields(entry: LoginEntrySummary): string {
  return `password ${mark(entry.fields.password)}  2FA ${mark(entry.fields.totp)}`;
}

/** How an entry signs in, naming the provider's saved login it goes via by its label when it still exists. */
function signInWords(entry: LoginEntrySummary, entries: readonly LoginEntrySummary[]): string {
  const method = loginMethodOf(entry);
  const via = method.via === undefined ? undefined : entries.find(other => other.id === method.via);
  const words = loginMethodSentence(method, via?.label);
  return method.via !== undefined && via === undefined ? `${words} (via ${method.via}, which is gone)` : words;
}

/** `fy secret entry hint`: the same words a ferret's `login_hint` reads. */
export function renderLoginHint(hint: LoginHintList): string {
  return loginHintSummary(hint.site, hint.hints);
}

/** The one-line outcome of a put or rename. */
export function renderLoginEntryLine(entry: LoginEntrySummary): string {
  return `${entry.id}  ${entry.label}  (${renderLoginEntryFields(entry)})`;
}

/** The listing: label, handle, what it matches, the plain username, and which secret fields exist. */
export function renderLoginEntryList(list: LoginEntryList): string {
  if (list.health === 'damaged')
    return [
      'This daemon cannot read its secret store, so its saved logins cannot be listed.',
      list.diagnosis ?? 'no diagnosis was given',
      '',
      'They are NOT gone. Do not add or edit any until the store is readable, or you may write over entries that are still there.',
    ].join('\n');
  if (list.entries.length === 0) return 'No saved logins on this daemon.';
  return list.entries
    .map(entry =>
      [
        `${entry.label}  [${entry.id}]`,
        `    match: ${entry.match.length === 0 ? '(nothing: never offered first)' : entry.match.join(', ')}`,
        `    sign-in: ${signInWords(entry, list.entries)}`,
        `    login domains: ${loginDomainsOf(entry).length === 0 ? '(none)' : loginDomainsOf(entry).join(', ')}`,
        ...(entry.username === undefined ? [] : [`    username: ${entry.username}`]),
        `    fields: ${renderLoginEntryFields(entry)}`,
      ].join('\n'),
    )
    .join('\n');
}

/** `fy secret entry recipe show`: the owner's steps, what the daemon saw, and each proposal as the change it would make. */
export function renderLoginRecipe(entry: LoginEntrySummary): string {
  const seen = entry.observed ?? [];
  const proposals = entry.proposals ?? [];
  return [
    `${entry.label}  [${entry.id}]`,
    `auto-apply a ferret's proposal: ${entry.autoApplyRecipe === true ? 'on' : 'off'}`,
    '',
    entry.recipe ?? "(no recipe yet: write one with \`recipe set\`, or approve a ferret's proposal)",
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
