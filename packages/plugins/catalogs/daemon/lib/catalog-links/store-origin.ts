import { isLoopbackHost, linkStoreOriginProblem } from '../boundary.ts';

/**
 * Why an address cannot be a link store, or `null` when it can: an `https:` origin with nothing after the host.
 * An `http:` origin is held only when it is this computer itself, which nothing on the network can sit between.
 * The address may carry a trailing path or slash (a directory origin does); only its origin is judged and used.
 */
export function linkStoreSiteProblem(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return 'the link store address is not an address';
  }
  if (url.username !== '' || url.password !== '') return 'the link store address carries a user name or password';
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return null;
  return linkStoreOriginProblem(url.origin);
}
