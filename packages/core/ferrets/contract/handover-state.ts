import { defineState } from '@ferretry/kernel/contract';
import { SessionHandoverReceiptSchema } from './handover.ts';

/**
 * `<sourceSessionId>/handover.json`: the durable cross-harness handover receipt, one per PREDECESSOR (the party that
 * exists in every phase), beside that ferret's own `ferret.json`. Today's `state/sessions/<id>/handover.json`.
 *
 * The schema is the wire contract's own (`./handover.ts`), so the daemon, the command line and the browser read the
 * very document the daemon writes. The receipt's refinements (a phase history that ends at the current phase, a
 * terminal failure that names a cause) are checked on every write and every read; the plan id is a pure function of
 * (source, request) that the daemon can hash and this contract cannot, so the daemon's store re-derives it on read.
 */
export const HandoverFiles = defineState({
  name: 'handover',
  path: '*/handover.json',
  store: 'json',
  format: 1,
  schema: SessionHandoverReceiptSchema,
});
