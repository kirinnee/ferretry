import type { LoginEntryList, LoginEntrySummary } from '@ferretry/protocol';

const mark = (present: boolean): string => (present ? '✓' : '–');

/** What an entry holds, as names: which secret fields exist, never what they contain. */
function renderLoginEntryFields(entry: LoginEntrySummary): string {
  return `password ${mark(entry.fields.password)}  2FA ${mark(entry.fields.totp)}`;
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
        ...(entry.username === undefined ? [] : [`    username: ${entry.username}`]),
        `    fields: ${renderLoginEntryFields(entry)}`,
      ].join('\n'),
    )
    .join('\n');
}
