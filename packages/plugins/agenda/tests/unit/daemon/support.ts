import { FakeAsks, entryId, sourceKey } from '@ferretry/core-asks/contract/testing';
import type { AskKind } from '@ferretry/core-asks/contract';

/** Raises one ask on a ferret's board through the fake Asks port, the way a ferret or a plugin would. */
export async function raiseAsk(
  asks: FakeAsks,
  ferret: string,
  entry: string,
  options: { readonly source?: string; readonly kind?: AskKind; readonly subject?: string } = {},
) {
  return await asks.raise({
    source: sourceKey(options.source ?? 'ferret'),
    ref: {},
    entry: entryId(entry),
    kind: options.kind ?? 'task',
    subject: options.subject ?? `Do ${entry}`,
    why: 'because',
    raisedBy: { kind: 'ferret', ferret },
    ferret,
  });
}
