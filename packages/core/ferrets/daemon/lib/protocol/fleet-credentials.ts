import { z } from 'zod';

/** Cut from today's `protocol/src/lib/fleet-credentials.ts` (Usage's): the one schema a session row embeds. */

/** Money left on a prepaid account or key, in the currency the provider reports it in. */
export const ProviderQuotaBalanceSchema = z.strictObject({
  amount: z.number().finite(),
  currency: z.string().regex(/^[A-Z]{3}$/u, 'a currency is a three-letter ISO code'),
});
export type ProviderQuotaBalance = z.infer<typeof ProviderQuotaBalanceSchema>;
