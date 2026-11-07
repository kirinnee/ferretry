export { ATTACHMENT_MANIFEST_STATE, ATTACHMENT_ORIGINAL_STATE } from '../../../contract/index.ts';

/** A name in the collection: `<ferret>~<attachment id>` (see the contract's state declarations). */
export const SEPARATOR = '~';
export const nameOf = (ferretId: string, attachmentId: string): string => `${ferretId}${SEPARATOR}${attachmentId}`;
