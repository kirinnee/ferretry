import { z } from 'zod';

const HostSchema = z.string().trim().min(1).max(255);
const PortSchema = z.number().int().min(1).max(65_535);

export const DaemonConfigSchema = z
  .object({
    host: HostSchema.default('127.0.0.1'),
    port: PortSchema.default(7337),
    publicUrl: z.url().optional(),
    healthIntervalSeconds: z.number().int().positive().default(30),
    transcriptReconcileSeconds: z.number().int().positive().default(2),
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
