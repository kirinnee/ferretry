import { policyRef } from '@ferretry/kernel/contract';

/** Audit kinds this plugin adds (one per route that changes the machine's rates). A read records nothing. */
export const PRICING_CHANGED_AUDIT = policyRef('audit', 'usage.pricing-changed');
export const PRICING_SYNCED_AUDIT = policyRef('audit', 'usage.pricing-synced');
/** A profile samples the daemon's own counters for a few seconds; it changes nothing but costs CPU, so it is recorded. */
export const PROFILE_STARTED_AUDIT = policyRef('audit', 'usage.profile-started');
