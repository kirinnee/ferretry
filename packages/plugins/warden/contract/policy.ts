import { type CapabilityAxis, type CapabilityDemand, policyRef } from '@ferretry/kernel/contract';

/** A grant demand on a capability Gate owns (`warden`). */
export const cap = (axis: CapabilityAxis): CapabilityDemand => ({
  capability: policyRef('capability', 'warden'),
  axis,
});

/**
 * The remedies the warden may exercise (§7.1): one per act it takes on a ferret. An administrator allows each by name in
 * `gate.yaml`; a route that carries one is not answered anonymously. Today's mounts declare none on a route (the warden
 * acts through its own token class); Ferrets' stop/resume/restart routes name these when they port (open question for the lead).
 */
export const WARDEN_REMEDIES = {
  nudge: policyRef('remedy', 'warden.nudge'),
  resume: policyRef('remedy', 'warden.resume'),
  restart: policyRef('remedy', 'warden.restart'),
  stop: policyRef('remedy', 'warden.stop'),
  failover: policyRef('remedy', 'warden.failover'),
  closeLeftover: policyRef('remedy', 'warden.close-leftover'),
  revive: policyRef('remedy', 'warden.revive'),
  bless: policyRef('remedy', 'warden.bless'),
} as const;

// Audit kinds this plugin adds.
export const WARDEN_RAN_AUDIT = policyRef('audit', 'warden.ran');
export const WARDEN_INVESTIGATED_AUDIT = policyRef('audit', 'warden.investigated');
export const WARDEN_LEFT_ALONE_AUDIT = policyRef('audit', 'warden.left-alone');
export const WARDEN_CONFIGURED_AUDIT = policyRef('audit', 'warden.configured');
