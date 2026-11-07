/**
 * Terminals' policy entries (§7.1), copied from today's `runtime/mounts/{terminals,session-processes,
 * session-console-input,session-attach,cgroups}.ts`, the surface control and owner-tools routes of
 * `agent-tools.ts`, and their audit rules. Gate owns the vocabulary; these are references into it.
 */
import type { AuditDeclaration, CapabilityDemand, GuardDeclaration } from '@ferretry/kernel/contract';
import { auditKind, CAPABILITIES } from '@ferretry/core-gate/contract';

export const CAPABILITY = {
  fleet: CAPABILITIES.fleet,
  terminal: CAPABILITIES.terminal,
} as const;

export const USE = {
  fleet: { capability: CAPABILITY.fleet, axis: 'use' },
  terminal: { capability: CAPABILITY.terminal, axis: 'use' },
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

/** `agentTool`: every tool call is one `agent.tool` entry — the tool, the terminal and lengths, never the text. */
export const AUDIT = {
  agentTool: auditKind('agent.tool'),
  surfaceControl: auditKind('surface.control'),
  terminalInput: auditKind('terminal.input'),
  terminalOpened: auditKind('terminal.opened'),
} as const;

export const SKIP_READ = { skip: 'a read: it changes nothing' } as const satisfies AuditDeclaration;
export const SKIP_UNRECORDED = { skip: 'not kept in the audit log today' } as const satisfies AuditDeclaration;
export const GUARD_NONE = {
  none: 'terminal ids, limits, holders and acknowledgements only; no pane text',
} as const satisfies GuardDeclaration;
/** A write-only act answers an `Ack` (§4.7): a fixed status and kernel-minted ids, never pane text. */
export const GUARD_ACK = {
  none: 'a write-only act: it answers an Ack, never pane text',
} as const satisfies GuardDeclaration;
