import { defineState } from '@ferretry/kernel/contract';
import { RenderIdSchema, StoredRenderMetaSchema } from '../../../contract/index.ts';

/**
 * The two collections a render is kept in: `renders/<id>.json`, its meta, and `renders/<id>.payload`, the payload text
 * exactly as saved. The contract declares `renders` as one opaque path, which cannot hold a collection; these are the
 * declarations the store needs (see the port report: the contract's `RENDERS_STATE` is replaced by these two).
 */
export const RENDER_META_STATE = defineState({
  name: 'render-meta',
  path: 'renders/*.json',
  store: 'json',
  format: 1,
  schema: StoredRenderMetaSchema,
  // A meta that does not parse is not a render and is never served; it does not take the plugin down.
  onDamaged: { narrower: 'a render whose meta does not parse is skipped: it is not served, so it grants nothing' },
});
export const RENDER_PAYLOAD_STATE = defineState({
  name: 'render-payload',
  path: 'renders/*.payload',
  store: 'opaque',
  format: 1,
});

export const isRenderId = (id: string): boolean => RenderIdSchema.safeParse(id).success;
