import { createHash as nodeCreateHash } from 'node:crypto';

/** Today's synchronous share lookup hash: admission has no suspension point. */
export const createHash = (text: string): string => nodeCreateHash('sha256').update(text).digest('hex');
