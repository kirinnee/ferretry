import { defineState } from '@ferretry/kernel/contract';

/**
 * The two byte files an attachment is kept in, `attachments/<ferret>~<attachment id>.original` and
 * `….manifest`. The contract declares the attachments as one opaque path per ferret, which cannot hold a collection; these are the
 * declarations the store needs (see the port report). Both are opaque: the manifest is parsed by
 * `parseStoredAttachmentManifest`, which owns what a usable one is, and the original is never parsed at all.
 *
 * `~` is in neither a ferret id (`[A-Za-z0-9._-]`) nor an attachment id (`att_<hex>`), so a name splits one way only.
 */
export const ATTACHMENT_ORIGINAL_STATE = defineState({
  name: 'attachment-original',
  path: 'attachments/*.original',
  store: 'opaque',
  format: 1,
});
export const ATTACHMENT_MANIFEST_STATE = defineState({
  name: 'attachment-manifest',
  path: 'attachments/*.manifest',
  store: 'opaque',
  format: 1,
});

export const SEPARATOR = '~';
export const nameOf = (ferretId: string, attachmentId: string): string => `${ferretId}${SEPARATOR}${attachmentId}`;
