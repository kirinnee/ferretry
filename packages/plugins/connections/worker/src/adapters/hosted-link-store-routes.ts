/**
 * The hosted Worker's link-store dispatch — `docs/relay-protocol.md` §13 ("The link-store binding") and §17.
 *
 * HOSTED MODE ONLY. A self-hosted relay never calls this, so every one of these paths falls through to
 * the rendezvous router there and answers the same 404 as any other unknown path.
 *
 * The relay does NOT interpret a link-store request. It forwards the request it received, unchanged and
 * unread, to the `LINK_STORE` service binding (the separate `ferretry-hosted-link-store` Worker). Unchanged
 * is the point: a daemon signs the host it discovered, and the store judges that signature against the host
 * of the URL it receives — the same URL the relay received. Unread is the other half: an upload body streams
 * straight through, and the store alone bounds it.
 *
 * A deployment without the binding stays honest: the advertisement says `available: false`, which is how a
 * daemon already treats a failed read, and every other path is a plain 404.
 */
import {
  DEFAULT_LINK_STORE_LIMITS,
  LINK_ENVELOPE_MAX_BYTES,
  LINK_STORE_CHALLENGE_PATH,
  LINK_STORE_OPERATOR_PATH,
  LINK_STORE_SERVICE_PATH,
  LINK_STORE_STATUS_PATH,
  LINK_STORE_VERSION,
  linkBundlePath,
  linkStoreRefusalBody,
} from '../lib/index.ts';

/** What the relay needs of the store: send it a request, get its answer. The Workers runtime's `Fetcher`. */
export interface LinkStoreBinding {
  fetch(request: Request): Promise<Response>;
}

export interface HostedLinkStoreEnvironment {
  readonly LINK_STORE?: LinkStoreBinding;
}

/** What an advertisement says when nothing answers it: the store's own answer for a control object it cannot read. */
const UNAVAILABLE_ADVERTISEMENT = {
  version: LINK_STORE_VERSION,
  available: false,
  maxEnvelopeBytes: LINK_ENVELOPE_MAX_BYTES,
  maxLiveLinks: DEFAULT_LINK_STORE_LIMITS.perDaemon.liveLinks,
} as const;

const LINKS_PREFIX = linkBundlePath('');
const PUBLIC_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store, max-age=0',
} as const;

export function isHostedLinkStorePath(pathname: string): boolean {
  return (
    pathname === LINK_STORE_SERVICE_PATH ||
    pathname === LINK_STORE_CHALLENGE_PATH ||
    pathname === LINK_STORE_STATUS_PATH ||
    pathname === LINK_STORE_OPERATOR_PATH ||
    pathname.startsWith(LINKS_PREFIX)
  );
}

export async function hostedLinkStoreFetch(
  request: Request,
  environment: HostedLinkStoreEnvironment,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const store = environment.LINK_STORE;
  if (store === undefined) return absent(request, pathname);
  try {
    return await store.fetch(request);
  } catch {
    return pathname === LINK_STORE_SERVICE_PATH ? advertisedUnavailable() : refusedUnavailable();
  }
}

/** No binding: the one question a client asks first gets a true answer, and nothing else is served. */
function absent(request: Request, pathname: string): Response {
  if (pathname !== LINK_STORE_SERVICE_PATH) return new Response('not found', { status: 404 });
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { ...PUBLIC_HEADERS, 'Access-Control-Allow-Methods': 'GET, OPTIONS' },
    });
  }
  return request.method === 'GET' ? advertisedUnavailable() : new Response('not found', { status: 404 });
}

function advertisedUnavailable(): Response {
  return new Response(JSON.stringify(UNAVAILABLE_ADVERTISEMENT), {
    status: 200,
    headers: { ...PUBLIC_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** The store could not be reached: the store's own refusal, in the store's own bytes, so a client reads one dialect. */
function refusedUnavailable(): Response {
  return new Response(linkStoreRefusalBody('link_store_unavailable'), {
    status: 503,
    headers: { ...PUBLIC_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
