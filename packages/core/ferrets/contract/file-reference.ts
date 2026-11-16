import { z } from 'zod';

/**
 * PROOF FOR AN `@file` REFERENCE (docs/reference-standard.md: syntax is never proof), single-sourced here because
 * Ferrets' file browser, Conversation's chat and Agenda's asks must agree on which written path names a file this
 * ferret's folder really holds, and none of them may import another's app half.
 *
 * THE PROOF READS ONLY A FOLDER LISTING, through the caller's own client, by route key. The daemon decides what may be
 * listed (the `filesystem` grant and the agent fence), so a refused read is a path that proves NOTHING. An entry the
 * listing marks `denied`, `ignored` or `escapes` is never proved, and no file's bytes are read.
 */

const hasUnsupportedNameChar = (value: string): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\' || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

/** One path segment a reader may open: not empty, not `.` or `..`, no `/`, backslash or control character (NUL included). */
export const isOpenableName = (name: string | null | undefined): boolean => {
  const value = name ?? '';
  return value !== '' && value !== '.' && value !== '..' && !value.includes('/') && !hasUnsupportedNameChar(value);
};

/** A folder-relative path every segment of which is openable. */
export const isOpenablePath = (rel: string | null | undefined): boolean =>
  !!rel && rel.split('/').every(isOpenableName);

/**
 * The folder-relative path a written candidate names, or `null` when it is outside the folder or cannot be opened:
 * session-relative, `./`-relative, or absolute INSIDE `cwd`. Without a `cwd` an absolute path names nothing.
 */
export const codeReferenceRelativePath = (candidate: string, cwd?: string): string | null => {
  let value = candidate;
  if (value.startsWith('/')) {
    const base = cwd?.replace(/\/+$/u, '');
    if (!base?.startsWith('/') || value === base || !value.startsWith(`${base}/`)) return null;
    value = value.slice(base.length + 1);
  } else if (value.startsWith('./')) value = value.slice(2);
  return isOpenablePath(value) ? value : null;
};

/** What the proof asks of a client: one call by route key. A `PluginClient` fits. */
export interface FileProofClient {
  call<Result = unknown>(
    route: string,
    request?: { readonly params?: Record<string, string>; readonly query?: Record<string, string> },
  ): Promise<Result>;
}

/** The only fields of a folder listing the proof trusts, parsed: a body of another shape proves nothing. */
const ListingSchema = z.looseObject({
  entries: z.array(
    z.looseObject({
      name: z.string(),
      type: z.string(),
      denied: z.boolean().optional(),
      ignored: z.boolean().optional(),
      escapes: z.boolean().optional(),
    }),
  ),
});

const LIST_ROUTE = 'GET /v1/ferrets/:ferretId/fs';

const parentOf = (relative: string): string => relative.slice(0, Math.max(0, relative.lastIndexOf('/')));
const baseOf = (relative: string): string => relative.slice(relative.lastIndexOf('/') + 1);

/**
 * Which of the written `candidates` name a file this ferret's folder really holds: written path to folder-relative
 * path. Each folder is listed once. A folder the daemon refuses (a 403 without the `filesystem` grant, or any other
 * failure) or answers in another shape proves none of its files; a caller that stopped waiting gets the abort.
 */
export const resolveFilePaths = async (
  client: FileProofClient,
  ferretId: string,
  candidates: readonly string[],
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, string>> => {
  const folders = new Map<string, Array<{ readonly authored: string; readonly relative: string }>>();
  for (const authored of new Set(candidates)) {
    const relative = codeReferenceRelativePath(authored, cwd);
    if (relative === null) continue;
    const folder = parentOf(relative);
    folders.set(folder, [...(folders.get(folder) ?? []), { authored, relative }]);
  }
  const proved = new Map<string, string>();
  await Promise.all(
    [...folders].map(async ([folder, rows]) => {
      signal.throwIfAborted();
      let answer: unknown;
      try {
        answer = await client.call(LIST_ROUTE, {
          params: { ferretId },
          ...(folder === '' ? {} : { query: { path: folder } }),
        });
      } catch {
        // A refusal (no `filesystem` grant, a fenced folder, an unreachable daemon) proves nothing; an abort is the caller's.
        signal.throwIfAborted();
        return;
      }
      signal.throwIfAborted();
      const listing = ListingSchema.safeParse(answer);
      if (!listing.success) return;
      const entries = new Map(listing.data.entries.map(entry => [entry.name, entry]));
      for (const { authored, relative } of rows) {
        const entry = entries.get(baseOf(relative));
        if (entry?.type === 'file' && entry.denied !== true && entry.ignored !== true && entry.escapes !== true)
          proved.set(authored, relative);
      }
    }),
  );
  return proved;
};
