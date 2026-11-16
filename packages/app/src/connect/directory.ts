import type { DirectoryFetch } from './provides.ts';

/**
 * THE HOSTED RELAY DIRECTORY READ (R580): the one network call a provider may make that is not a sealed session.
 *
 * It is a public, credential-free `GET` of the operator's no-store advertisement, and nothing else: the address must
 * sit on the build-time directory origin (`__FY_RELAY_DIRECTORY__`, the same value the daemon reads), the method must
 * be `GET`, and no credentials or referrer travel with it. Anything else is refused before a byte leaves the tab, so
 * this port can never become a daemon request that skips the session. A build with no directory gets no port at all,
 * and discovery then fails closed to direct-only.
 */
export function directoryFetch(origin: string | undefined): DirectoryFetch | undefined {
  if (origin === undefined || origin === '') return undefined;
  let allowed: string;
  try {
    allowed = new URL(origin).origin;
  } catch {
    return undefined;
  }
  return async (url, init = {}) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new Error('the relay directory read was given an address that is not a URL');
    }
    if (target.origin !== allowed)
      throw new Error('the relay directory read only reaches the build’s directory origin');
    if ((init.method ?? 'GET').toUpperCase() !== 'GET') throw new Error('the relay directory read is a GET');
    return await globalThis.fetch(target.toString(), {
      ...init,
      method: 'GET',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  };
}
