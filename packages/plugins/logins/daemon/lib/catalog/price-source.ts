/**
 * The maker whose billing rules a catalog price follows, and the https-only source URL it was read on (today's
 * analytics-pricing schemas, the two a catalog price uses).
 */
import { z } from 'zod';

export const ANALYTICS_PRICING_PROVIDERS = [
  'openai',
  'anthropic',
  'deepseek',
  'moonshot',
  'zai',
  'minimax',
  'alibaba',
] as const;
export const AnalyticsPricingProviderSchema = z.enum(ANALYTICS_PRICING_PROVIDERS);
export type AnalyticsPricingProvider = z.infer<typeof AnalyticsPricingProviderSchema>;

export const AnalyticsPricingSourceUrlSchema = z
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    // Checks still run after the format check fails, so a value that is not a URL at all is left to
    // the message `z.url()` already produced rather than parsed again here.
    if (!URL.canParse(value)) return;
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      context.addIssue({ code: 'custom', message: 'pricing sources must be fetched over https' });
    }
    if (url.username !== '' || url.password !== '') {
      context.addIssue({ code: 'custom', message: 'pricing source URLs may not carry credentials' });
    }
    if (url.hash !== '') {
      context.addIssue({ code: 'custom', message: 'pricing source URLs may not carry a fragment' });
    }
  });
