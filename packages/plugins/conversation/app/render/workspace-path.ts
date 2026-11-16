/**
 * A path a `fy-render` media block names, made folder-relative the way an `@file` reference is (today's `files-model.ts`
 * `isOpenableName` / `isOpenablePath` and `files-api.ts` `codeReferenceRelativePath`).
 */

const hasUnsupportedNameChar = (value: string): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\\' || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
};

const isOpenableName = (name: string | null | undefined): boolean => {
  const value = name ?? '';
  return value !== '' && value !== '.' && value !== '..' && !value.includes('/') && !hasUnsupportedNameChar(value);
};

const isOpenablePath = (rel: string | null | undefined): boolean => !!rel && rel.split('/').every(isOpenableName);

/** The folder-relative path a candidate names, or `null` when it is outside the folder or cannot be opened. */
export const codeReferenceRelativePath = (candidate: string, cwd?: string): string | null => {
  let value = candidate;
  if (value.startsWith('/')) {
    const base = cwd?.replace(/\/+$/u, '');
    if (!base?.startsWith('/') || value === base || !value.startsWith(`${base}/`)) return null;
    value = value.slice(base.length + 1);
  } else if (value.startsWith('./')) value = value.slice(2);
  return isOpenablePath(value) ? value : null;
};
