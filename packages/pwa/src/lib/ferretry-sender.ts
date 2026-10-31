import type { LedgerSendRecord } from './send-ledger.ts';

/** Which part of Ferretry sent this, when the sender says it is Ferretry itself — as metadata, never read from the words. */
export const ferretryFeatureOf = (record: LedgerSendRecord | undefined): string | undefined => {
  const by = record?.queue?.by ?? record?.by;
  return by?.kind === 'ferretry' ? by.feature : undefined;
};

/** The one line a person reads of a Ferretry message, and whether more words sit behind "Show". */
export function ferretryLine(text: string): { readonly line: string; readonly long: boolean } {
  const lines = text
    .split('\n')
    .map(candidate => candidate.trim())
    .filter(candidate => candidate !== '');
  const first = lines[0] ?? '';
  const line = first.length > 140 ? `${first.slice(0, 139).trimEnd()}…` : first;
  return { line, long: lines.length > 1 || first.length > 140 };
}
