import { z } from 'zod';

const HostSchema = z.string().trim().min(1).max(255);
const PortSchema = z.number().int().min(1).max(65_535);

/**
 * Where the daemon reads account health from.
 *
 * Both sources are optional and tried in order. Neither is defaulted to a particular tool or
 * address: the source hardcoded one collector's name and flags into the daemon, so a host that ran
 * anything else had no fallback at all and no way to configure one.
 */
export const UsageFeedConfigSchema = z
  .object({
    /** The fleet collector's JSON usage endpoint. */
    url: z.url().optional(),
    /**
     * Fallback command for hosts where the collector is not listening, as argv. The daemon appends
     * the flags it needs (see `USAGE_PROBE_FLAGS`); an empty list means there is no fallback.
     */
    fallbackCommand: z.array(z.string().trim().min(1)).readonly().default([]),
    /** How long one collected snapshot is served before the feed refreshes it. */
    refreshSeconds: z.number().int().positive().default(300),
  })
  .strict();

export type UsageFeedConfig = z.output<typeof UsageFeedConfigSchema>;

export const DaemonConfigSchema = z
  .object({
    host: HostSchema.default('127.0.0.1'),
    port: PortSchema.default(7337),
    publicUrl: z.url().optional(),
    secretsFile: z.string().trim().min(1).optional(),
    healthIntervalSeconds: z.number().int().positive().default(30),
    transcriptReconcileSeconds: z.number().int().positive().default(2),
    usage: UsageFeedConfigSchema.prefault({}),
  })
  .strict()
  .transform(value => ({ ...value, publicUrl: value.publicUrl ?? `http://${value.host}:${value.port}` }));

export type DaemonConfig = z.output<typeof DaemonConfigSchema>;

/** Parses a complete configuration document and derives its canonical public URL. */
export function parseDaemonConfig(value: unknown): DaemonConfig {
  return DaemonConfigSchema.parse(value);
}

export function defaultDaemonConfig(): DaemonConfig {
  return parseDaemonConfig({});
}
