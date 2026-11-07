/**
 * Browsers' policy entries (§7.1), copied from today's `runtime/mounts/{browser,browser-login,browser-proxy}.ts`, the
 * browser surface control and owner-tools routes of `agent-tools.ts`, and their audit rules.
 */
import type { AuditDeclaration, CapabilityDemand, GuardDeclaration } from '@ferretry/kernel/contract';
import { auditKind, CAPABILITIES } from './core.ts';

export const CAPABILITY = {
  browser: CAPABILITIES.browser,
} as const;

export const USE = {
  browser: { capability: CAPABILITY.browser, axis: 'use' },
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

export const CONFIGURE = {
  browser: { capability: CAPABILITY.browser, axis: 'configure' },
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

export const AUDIT = {
  agentTool: auditKind('agent.tool'),
  browserOpened: auditKind('browser.opened'),
  browserProxyTested: auditKind('browser.proxy-tested'),
  surfaceControl: auditKind('surface.control'),
} as const;

export const SKIP_READ = { skip: 'a read: it changes nothing' } as const satisfies AuditDeclaration;
export const SKIP_UNRECORDED = { skip: 'not kept in the audit log today' } as const satisfies AuditDeclaration;
export const GUARD_NONE = {
  none: 'browser lifecycle, proxy state and surface control only; no page text',
} as const satisfies GuardDeclaration;
/** A write-only act answers an `Ack` (§4.7): never a URL, a title or any page-derived string. */
export const GUARD_ACK = {
  none: 'a write-only act: it answers an Ack, never page text',
} as const satisfies GuardDeclaration;
