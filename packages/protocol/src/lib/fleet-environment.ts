import { z } from 'zod';

/**
 * What `GET /v1/fleet/environment` answers: each fleet profile's PORTABLE environment.
 *
 * Portable means the daemon has already dropped every entry that cannot travel between hosts — a
 * credential-shaped name, a machine-local path or address — so this view holds configuration and
 * nothing a browser should not see. The record is keyed by profile name, then by variable name.
 *
 * The PWA used to read this route with a hand-written interface and a cast, so a daemon answering
 * anything else (a proxy's HTML page, an older shape) became a crash somewhere in a render rather
 * than one sentence at the boundary.
 */
export const FleetEnvironmentViewSchema = z.object({
  profiles: z.record(z.string(), z.record(z.string(), z.string())),
});
export type FleetEnvironmentView = z.infer<typeof FleetEnvironmentViewSchema>;
