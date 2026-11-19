import { MAX_FILES_PATCH_BYTES, PullFileSchema, type PullFile } from '../../../contract/index.ts';

/** What GitHub's `GET /pulls/{n}/files` sends per file, as far as this unit reads it. Anything else is ignored. */
const GITHUB_BLOB = /^https:\/\/github\.com\//u;

const utf8 = new TextEncoder();
/** One file's patch past this is not carried (the schema's own bound). */
const MAX_ONE_PATCH_BYTES = 1024 * 1024;

/**
 * GitHub's file entries as `PullFile`s. A file GitHub sent in a shape we do not understand is counted and left out; the
 * patch of the files past `MAX_FILES_PATCH_BYTES` in total is dropped (the app says "open on GitHub" for a file with no
 * patch), so one answer is bounded however large the PR. No GitHub text is passed on except the file's own path, status,
 * counts, patch and blob link.
 */
export function shapeFiles(items: readonly unknown[]): {
  files: PullFile[];
  unreadable: number;
  patchesDropped: number;
} {
  const files: PullFile[] = [];
  let unreadable = 0;
  let patchesDropped = 0;
  let patchBytes = 0;
  for (const item of items) {
    const raw = item as Record<string, unknown> | null;
    if (raw === null || typeof raw !== 'object') {
      unreadable += 1;
      continue;
    }
    const blob = typeof raw.blob_url === 'string' && GITHUB_BLOB.test(raw.blob_url) ? raw.blob_url : undefined;
    let patch = typeof raw.patch === 'string' && raw.patch !== '' ? raw.patch : undefined;
    if (patch !== undefined) {
      const size = utf8.encode(patch).byteLength;
      if (size > MAX_ONE_PATCH_BYTES || patchBytes + size > MAX_FILES_PATCH_BYTES) {
        patch = undefined;
        patchesDropped += 1;
      } else patchBytes += size;
    }
    const parsed = PullFileSchema.safeParse({
      path: raw.filename,
      ...(typeof raw.previous_filename === 'string' ? { previousPath: raw.previous_filename } : {}),
      status: raw.status,
      additions: raw.additions,
      deletions: raw.deletions,
      ...(patch === undefined ? {} : { patch }),
      ...(blob === undefined ? {} : { url: blob }),
    });
    if (parsed.success) files.push(parsed.data);
    else unreadable += 1;
  }
  return { files, unreadable, patchesDropped };
}
