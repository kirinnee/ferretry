/**
 * HTTP to the hosts the manifest declared in `permissions.network`; anything else is refused before a socket opens.
 *
 * GAP: this main-thread port still forwards a `Host` header a plugin sets, because the guard judges the URL's host
 * and today's port did not refuse it either; only the worker grant channel refuses `Host`.
 */
export interface FetchPort {
  request(url: string | URL, init?: RequestInit): Promise<Response>;
}
