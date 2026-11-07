import { defineState } from '@ferretry/kernel/contract';

/**
 * `<ferret>/move-inflight.md`: the forensic account of what a move's kill interrupted, one per ferret, beside its own
 * `ferret.json`. Today's `state/sessions/<id>/move-inflight.md`.
 *
 * OPAQUE, because it is markdown the daemon writes and the relaunched agent reads: the kernel keeps the bytes as they
 * are and never parses them. The file's ABSOLUTE PATH is handed to the replacement agent in its hand-off turn
 * (`StatePort.pathOf`), so the agent reads the very document the daemon wrote.
 *
 * Written in two halves (the inventory before the pane is killed, the outcome after the attempt settles) and
 * overwritten whole by a second move: one report per ferret, whichever move it is the account of.
 */
export const MoveInflightFiles = defineState<'move-inflight', Uint8Array>({
  name: 'move-inflight',
  path: '*/move-inflight.md',
  store: 'opaque',
  format: 1,
  mode: 0o600,
});
