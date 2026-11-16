import { RenderIdSchema } from '../../../contract/index.ts';

export { RENDER_META_STATE, RENDER_PAYLOAD_STATE } from '../../../contract/index.ts';

export const isRenderId = (id: string): boolean => RenderIdSchema.safeParse(id).success;
