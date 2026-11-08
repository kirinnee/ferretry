import { z } from 'zod';
import { defineEvent, defineHook } from './define.ts';
import { PROTOCOL } from './session.ts';
import type { Carrier, SessionMode } from './session.ts';

/** The Kernel's own hooks (§3.5 table). The taker lists are the security-path allowlists; changing one is reviewed. */

export const CarrierKeySchema = z.enum(['direct', 'relay', 'tunnel', 'webrtc']);
export const Carriers = defineHook('carriers', {
  mode: 'provide',
  key: CarrierKeySchema,
  value: z.custom<Carrier>(),
  takers: ['connections'],
});

export const SessionModeKeySchema = z.enum(['device', 'pair', 'member']);
export const SessionModes = defineHook('session.modes', {
  mode: 'provide',
  key: SessionModeKeySchema,
  value: z.custom<SessionMode>(),
  takers: ['access', 'catalogs'],
});

/** One `fy doctor` check. `run` reads only the plugin's own ports; never a secret in `detail`. */
export interface DoctorCheck {
  readonly id: string;
  readonly title: string;
  run(): Promise<DoctorFinding>;
}
export interface DoctorFinding {
  readonly state: 'ok' | 'warn' | 'fail';
  readonly detail: string;
  readonly fix?: string;
}
export const DoctorChecks = defineHook('doctor.checks', { mode: 'contribute', item: z.custom<DoctorCheck>() });

/** A plugin turned on or off, or the daemon restarted on a new build (§9.6). A core event. */
export const PluginsChanged = defineEvent('kernel.plugins-changed', z.strictObject({ generation: z.number().int() }));

/**
 * The feature name `GET /v1/health` lists so that a `fy` released before 5.0 never opens the host's admin token against
 * this daemon. Such a `fy`, in a ferret's pane, presents the ferret's own `fys_` credential only to a daemon whose health
 * lists this name; and after a `401` it reads health again and, when the name is missing, takes that as PROOF of an
 * older daemon and sends the request again with the admin token. A 5.0 daemon always takes the ferret's credential
 * (Gate resolves it on every route), so it always lists the name: its `401` to an unknown or revoked credential is the
 * answer, never a reason to fall back. Only a daemon that really is older (whose health lacks the name) still earns the
 * fallback, and that is the older CLI's own rule.
 */
export const SESSION_CREDENTIAL_FEATURE = 'session.credential.1';

/** `GET /v1/health` (§9.6). `features` is optional to read: only {@link SESSION_CREDENTIAL_FEATURE} is ever listed. */
export const HealthSchema = z.strictObject({
  protocol: z.literal(PROTOCOL),
  version: z.string(),
  features: z.array(z.string()).optional(),
});
export type Health = z.infer<typeof HealthSchema>;

/** `GET /v1/plugins`, projected by Gate per standing (§9.6). `contract` is the effective contract hash. */
export const PluginInventorySchema = z.strictObject({
  protocol: z.literal(PROTOCOL),
  plugins: z.array(z.strictObject({ id: z.string(), on: z.boolean(), contract: z.string() })),
});
export type PluginInventory = z.infer<typeof PluginInventorySchema>;
