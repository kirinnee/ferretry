/** @ferretry/core-mailbox/contract — the wire a message to a ferret travels on, its port, events, slot and stored shapes. */
export * from './codes.ts';
export * from './delivery-way.ts';
export * from './events.ts';
export * from './host.ts';
export * from './lines.ts';
export * from './peer-messages.ts';
export * from './port.ts';
// The ledger's own send shapes share three names with the wire's (`SendFate`, `SendPath`, `SendRecord`: the wire view
// versus what the daemon keeps), so the stored ones leave under `Ledger*` and Conversation's send path renames them back.
export type {
  SendFate as LedgerFate,
  SendLedger,
  SendNoticeOwed,
  SendPath as LedgerPath,
  SendRecord as LedgerRecord,
  SendSenderKind,
  SendSettlement,
  SessionQueueStore,
} from './stores.ts';
export * from './wire-send.ts';
