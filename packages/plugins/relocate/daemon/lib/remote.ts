/**
 * A git remote as `https://<host>/<path>`: the one spelling two machines compare, and the one spelling Projects records
 * (`ProjectRepo.remote`). `https://github.com/o/n.git`, `git@github.com:o/n` and `ssh://git@github.com/o/n.git` are the same
 * repository. The user and any password are dropped, because a remote as written may carry a token, and nothing that
 * carries one may cross a move. Anything that is not a network address (a local path, `file:`) answers `undefined`.
 */
export function normalizeRemote(raw: string): string | undefined {
  const text = raw.trim();
  if (text === '' || /[\p{Cc}\s]/u.test(text)) return undefined;
  const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/u.exec(text);
  const url = scp === null ? text : `ssh://${scp[1] ?? ''}/${scp[2] ?? ''}`;
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol) || parsed.hostname === '') return undefined;
  const path = parsed.pathname.replace(/\/+$/u, '').replace(/\.git$/u, '');
  if (path === '' || path === '/') return undefined;
  return `https://${parsed.hostname.toLowerCase()}${path}`;
}

/** Only explicit network transports. Never let git interpret a local path, helper or option as a remote. */
export function approvedRemote(remote: string): boolean {
  if (/[\s\p{Cc}\\]/u.test(remote) || !URL.canParse(remote)) return false;
  const url = new URL(remote);
  return (
    ['https:', 'ssh:'].includes(url.protocol) &&
    url.hostname !== '' &&
    url.password === '' &&
    (url.protocol === 'ssh:' || url.username === '') &&
    url.pathname !== '/' &&
    url.search === '' &&
    url.hash === ''
  );
}
