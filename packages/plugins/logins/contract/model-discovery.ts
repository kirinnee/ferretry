import { z } from 'zod';

/** Public models.dev metadata from the signed catalog, kept separate from curated models and defaults. */
export const ModelDiscoverySchema = z.object({
  providers: z.record(
    z.string().min(1).max(200),
    z.object({
      name: z.string().min(1).max(200),
      /** Native environment variable names only, for identifying the provider a login serves. */
      env: z
        .array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u))
        .max(16)
        .optional(),
      models: z.record(
        z.string().min(1).max(200),
        z.object({
          name: z.string().min(1).max(200),
          reasoning: z.boolean().optional(),
          tool_call: z.boolean().optional(),
          limit: z.object({ context: z.number().int().nonnegative().max(1_000_000_000).optional() }).optional(),
          status: z.enum(['alpha', 'beta', 'retiring']).optional(),
          retires: z
            .string()
            .regex(/^\d{4}-\d{2}(?:-\d{2})?$/u)
            .optional(),
        }),
      ),
    }),
  ),
});
export type ModelDiscovery = z.infer<typeof ModelDiscoverySchema>;
