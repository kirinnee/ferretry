/** Who a send is from, as the daemon says it (today's `send-ledger.ts` `LedgerSender`). */
interface LedgerSender {
  readonly kind: 'owner' | 'ferret' | 'ferretry';
  readonly name?: string;
  readonly feature?: string;
}

/**
 * GAP(C3): the part of a send-ledger row this file reads, until C3's `chat/send-ledger.ts` exports `LedgerSendRecord`
 * (the queue's own record of who sent it, or the ledger's, for a send that never went through the queue).
 */
export interface LedgerSendRecord {
  readonly by?: LedgerSender;
  readonly queue?: { readonly by?: LedgerSender };
}

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

/** What "Show" reveals: the lines after the one already on the row, or everything when that line was cut short. */
export function ferretryRest(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex(candidate => candidate.trim() !== '');
  const first = lines[start]?.trim() ?? '';
  if (first.length > 140) return text.trim();
  return lines
    .slice(start + 1)
    .join('\n')
    .trim();
}
