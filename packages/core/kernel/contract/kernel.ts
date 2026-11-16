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
  /**
   * The row's name when it is not "<plugin>: <check>" (today's rows were named for the thing checked: `tmux`,
   * `claude`, `loopback firewall`). The report's `name`.
   */
  readonly name?: string;
  /** The kind of consequence a miss has (today's `requirement`); absent: a failure is `required`, a warning `optional`. */
  readonly requirement?: 'required' | 'capability' | 'optional' | 'alternative';
  /** The thing checked does not apply on this host (today's `n/a` row): present and never a warning. */
  readonly notApplicable?: true;
}
export const DoctorChecks = defineHook('doctor.checks', { mode: 'contribute', item: z.custom<DoctorCheck>() });

/** A plugin turned on or off, or the daemon restarted on a new build (§9.6). A core event. */
export const PluginsChanged = defineEvent('kernel.plugins-changed', z.strictObject({ generation: z.number().int() }));

/**
 * One declared config file moved on disk or in state (written, held for the owner, confirmed, discarded, broken,
 * fixed, removed): what an open settings card or file editor re-reads on, over `GET /v1/bus` (it replaces today's
 * `/v1/events?topic=config` stream). The file's path under `config/`, its plugin, its state and its disk etag (the one
 * `GET /v1/config/file` answers) — NEVER its text, a value or a sentence. A frame reaches only a caller whom
 * `GET /v1/config/file` would let read that file. It is the app's: no plugin hears it in-process (a plugin hears its
 * own files through `ConfigPort.watchState`).
 */
export const ConfigChanged = defineEvent(
  'kernel.config-changed',
  z.strictObject({
    plugin: z.string().min(1).max(64),
    path: z.string().min(1).max(512),
    state: z.enum(['absent', 'valid', 'invalid', 'held']),
    etag: z.string().min(1).max(128),
  }),
);

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
