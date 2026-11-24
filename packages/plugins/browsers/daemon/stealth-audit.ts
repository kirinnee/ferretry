import type { AuditDraft } from '@ferretry/core-gate/contract';
import { AUDIT, type StealthSwitch, StealthAuditDetailSchemas } from '../contract/index.ts';

export interface StealthSwitchAuditPorts {
  /** The switch in effect now (a held edit is not in effect, so it is not read here). */
  readonly read: () => StealthSwitch;
  /** Hears the version in effect move (`kernel.config.watch`). */
  readonly watch: (listener: () => void) => () => void;
  readonly record: (draft: AuditDraft) => Promise<void>;
  /** Hears a record that could not be written, so a failed audit write is said, not an unhandled rejection. */
  readonly failed: (error: unknown) => void;
}

/**
 * Records `browser.stealth.switched` (from, to) each time the machine-wide switch really changes: when the version in
 * effect moves, so an `on` held for the owner leaves no record until it is confirmed. The change is seen at reload,
 * where the writer is not known; the config route's own record says who wrote it, so the actor here is the machine.
 */
export function auditStealthSwitch(ports: StealthSwitchAuditPorts): () => void {
  let last = ports.read();
  return ports.watch(() => {
    const now = ports.read();
    if (now === last) return;
    const detail = StealthAuditDetailSchemas.switched.parse({ from: last, to: now });
    last = now;
    ports
      .record({ event: AUDIT.stealthSwitched, actor: { kind: 'host' }, outcome: 'succeeded', detail })
      .catch(ports.failed);
  });
}
