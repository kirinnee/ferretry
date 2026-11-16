/**
 * A policy value the kernel carries but never interprets (§7.1). Gate's contract owns the vocabulary; a plugin adds
 * its own entries (a capability per tool, a remedy per warden action, an audit kind) through its manifest.
 *
 * The brand is per kind, so `PolicyRef<'capability'>` is not a `PolicyRef<'step-up-act'>` (tests/types).
 */
export type PolicyKind = 'capability' | 'remedy' | 'audit' | 'step-up-act';
export type PolicyRef<K extends PolicyKind> = string & { readonly __policy: K };

const POLICY_NAME = /^[a-z][a-z0-9]*(?:[-.:][a-z0-9]+)*$/;

/**
 * Mints a policy ref. Only a contract calls this (Gate for its vocabulary, a plugin for the entries it adds);
 * a handler never does. Throws on a malformed name because a contract is module-level data, checked at load.
 */
export function policyRef<K extends PolicyKind>(kind: K, name: string): PolicyRef<K> {
  if (!POLICY_NAME.test(name)) throw new TypeError(`policy ${kind} "${name}" is not a dotted kebab name`);
  return name as PolicyRef<K>;
}

/** The grant axis a governed call needs (§7.1): use the thing, or change its settings. */
export type CapabilityAxis = 'use' | 'configure';
