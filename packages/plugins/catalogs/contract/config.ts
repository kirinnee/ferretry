import { defineConfig } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { linkStoreOriginProblem } from './wire/index.ts';

export const LinkStoreSettingSchema = z.union([
  z.strictObject({ source: z.literal('discovery') }),
  z.strictObject({
    url: z.string().refine(value => linkStoreOriginProblem(value) === null, 'a plain link-store origin'),
  }),
  z.strictObject({ enabled: z.literal(false) }),
]);
export type LinkStoreSetting = z.infer<typeof LinkStoreSettingSchema>;

/** How long a member's passkey unlock lasts, in days: today's `catalogs.memberUnlockDays`. */
export const MEMBER_UNLOCK_DAYS = { min: 1, max: 90, default: 30 } as const;

export const CatalogsConfigSchema = z.strictObject({
  linkStore: LinkStoreSettingSchema.default({ source: 'discovery' }),
  memberUnlockDays: z
    .number()
    .int()
    .min(MEMBER_UNLOCK_DAYS.min)
    .max(MEMBER_UNLOCK_DAYS.max)
    .default(MEMBER_UNLOCK_DAYS.default),
});
export type CatalogsConfig = z.infer<typeof CatalogsConfigSchema>;

export function catalogConfigLoosens(
  before: CatalogsConfig | undefined,
  after: CatalogsConfig | undefined,
): readonly string[] {
  const old = before?.linkStore ?? { source: 'discovery' };
  const next = after?.linkStore ?? { source: 'discovery' };
  const loosened: string[] = [];
  if (!('enabled' in next)) {
    if ('enabled' in old) loosened.push('Download links can be published again.');
    else if (('url' in old ? old.url : 'discovery') !== ('url' in next ? next.url : 'discovery'))
      loosened.push('Download links can be sent to another store.');
  }
  // A longer unlock lets a member's browser read for longer before it must prove its passkey again.
  if (
    (after?.memberUnlockDays ?? MEMBER_UNLOCK_DAYS.default) > (before?.memberUnlockDays ?? MEMBER_UNLOCK_DAYS.default)
  )
    loosened.push('A member can stay unlocked for longer before their passkey is asked again.');
  return loosened;
}
export const CatalogsConfigFile = defineConfig({
  file: 'catalogs.yaml',
  schema: CatalogsConfigSchema,
  axis: 'configure',
  personOnly: true,
  loosens: catalogConfigLoosens,
});
