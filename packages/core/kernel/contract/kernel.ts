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

/** `GET /v1/health` (§9.6). */
export const HealthSchema = z.strictObject({ protocol: z.literal(PROTOCOL), version: z.string() });
export type Health = z.infer<typeof HealthSchema>;

/** `GET /v1/plugins`, projected by Gate per standing (§9.6). `contract` is the effective contract hash. */
export const PluginInventorySchema = z.strictObject({
  protocol: z.literal(PROTOCOL),
  plugins: z.array(z.strictObject({ id: z.string(), on: z.boolean(), contract: z.string() })),
});
export type PluginInventory = z.infer<typeof PluginInventorySchema>;
