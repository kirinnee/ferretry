import { isRecord } from './shared/is-record.ts';

/**
 * `ferrets.file-open`, the one hook Ferrets PROVIDES itself (a shared action: one provider, many callers). Another
 * half's `@file` link asks Ferrets' Files panel to show a path of one ferret.
 *
 * It only REQUESTS: `open` reads nothing, and the panel reads through `GET /v1/ferrets/:ferretId/fs`, so the
 * `filesystem` grant and the agent fence decide exactly as they do for a click inside Files. A path that is absolute,
 * climbs (`..`), carries a backslash or a control character (NUL included) is refused BEFORE any request, and `open`
 * answers `false`. With no provider, two, one that is not Ferrets, or a value of another shape, a caller has no opener and its `@file` stays prose.
 */
export const FERRETS_FILE_OPEN_HOOK = 'ferrets.file-open' as const;

/** The plugin that provides {@link FERRETS_FILE_OPEN_HOOK}: a caller reads it from there and from nowhere else. */
export const FERRETS_PLUGIN = 'ferrets' as const;

export interface FerretsFileOpen {
  /** Asks Files to show `path` (relative to the ferret's folder) of `ferretId`; `false` when the path was refused. */
  readonly open: (ferretId: string, path: string) => boolean;
}

export const isFerretsFileOpen = (value: unknown): value is FerretsFileOpen =>
  isRecord(value) && typeof value.open === 'function';

export default { name: FERRETS_FILE_OPEN_HOOK, narrow: isFerretsFileOpen } as const;
