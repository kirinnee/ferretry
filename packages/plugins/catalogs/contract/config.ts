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
export const CatalogsConfigSchema = z.strictObject({
  linkStore: LinkStoreSettingSchema.default({ source: 'discovery' }),
});
export type CatalogsConfig = z.infer<typeof CatalogsConfigSchema>;

export function catalogConfigLoosens(
  before: CatalogsConfig | undefined,
  after: CatalogsConfig | undefined,
): readonly string[] {
  const old = before?.linkStore ?? { source: 'discovery' };
  const next = after?.linkStore ?? { source: 'discovery' };
  if ('enabled' in next) return [];
  if ('enabled' in old) return ['Download links can be published again.'];
  if (('url' in old ? old.url : 'discovery') !== ('url' in next ? next.url : 'discovery'))
    return ['Download links can be sent to another store.'];
  return [];
}
export const CatalogsConfigFile = defineConfig({
  file: 'catalogs.yaml',
  schema: CatalogsConfigSchema,
  axis: 'configure',
  personOnly: true,
  loosens: catalogConfigLoosens,
});
