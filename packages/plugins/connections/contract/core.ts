/**
 * STAND-IN for `@ferretry/core-gate/contract` until the core-contracts slice lands on origin/rebuild/5.0. The ONLY
 * file here that names a Gate export, each by Gate's own name; replace the body with re-exports when Gate merges.
 */
import { type PolicyRef, policyRef } from '@ferretry/kernel/contract';

export const CAPABILITIES = {
  pairing: policyRef('capability', 'pairing'),
} as const satisfies Readonly<Record<string, PolicyRef<'capability'>>>;

export const auditKind = (name: string): PolicyRef<'audit'> => policyRef('audit', name);
