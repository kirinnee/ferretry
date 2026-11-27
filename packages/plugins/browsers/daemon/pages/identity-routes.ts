import { InstantSchema } from '@ferretry/std';
import { ApiError, type CallContext, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import {
  type BrowserIdentitiesView,
  type BrowserIdentityRow,
  type BrowsersConfig,
  BrowserIdentityKeySchema,
  DEFAULT_BROWSER_ENGINE,
  DEFAULT_BROWSER_IDENTITY,
  DEFAULT_MAX_RUNNING_IDENTITIES,
} from '../../contract/index.ts';
import type { BrowserStateView } from '../../contract/index.ts';

/** What the identity routes need from the composition root. */
export interface IdentityListing {
  readonly config: () => BrowsersConfig | undefined;
  /** Whether this identity's Chrome runs, since when. */
  readonly state: (identity: string) => BrowserStateView;
  /** Closes this identity's Chrome and pages, and no other identity's. */
  readonly stop: (identity: string) => Promise<void>;
  /** When this identity's profile folder last changed. */
  readonly lastUsedAt: (identity: string) => Promise<string | undefined>;
}

/** The proxy's name: where it is, never how it signs in. */
const proxyName = (url: string): string => new URL(url).host;

async function rowOf(
  listing: IdentityListing,
  config: BrowsersConfig | undefined,
  identity: string,
): Promise<BrowserIdentityRow> {
  const state = listing.state(identity);
  const own = config?.identities?.[identity]?.proxy;
  const shown = own ?? config?.proxy;
  const lastUsedAt = await listing.lastUsedAt(identity).catch(() => undefined);
  return {
    identity,
    builtIn: identity === DEFAULT_BROWSER_IDENTITY,
    engine: config?.identities?.[identity]?.engine ?? config?.engine ?? DEFAULT_BROWSER_ENGINE,
    running: state.state === 'running' || state.state === 'starting',
    ...(state.state === 'running' && state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
    ...(lastUsedAt === undefined ? {} : { lastUsedAt: InstantSchema.parse(lastUsedAt) }),
    ...(shown === undefined ? {} : { proxy: { name: proxyName(shown.url), own: own !== undefined } }),
  };
}

/** Every identity the daemon would open now: the built-in one, then each key `browsers.yaml` names. */
async function identitiesView(listing: IdentityListing): Promise<BrowserIdentitiesView> {
  const config = listing.config();
  const keys = [
    DEFAULT_BROWSER_IDENTITY,
    ...Object.keys(config?.identities ?? {}).filter(key => key !== DEFAULT_BROWSER_IDENTITY),
  ];
  return {
    identities: await Promise.all(keys.map(async key => await rowOf(listing, config, key))),
    maxRunning: config?.maxRunning ?? DEFAULT_MAX_RUNNING_IDENTITIES,
  };
}

/** The identity a stop is about: a key the daemon would open, else a 404 that names it. */
function stoppable(listing: IdentityListing, call: CallContext): string {
  const named = call.params.get('identity') ?? '';
  const configured =
    listing.config()?.identities !== undefined && Object.hasOwn(listing.config()?.identities ?? {}, named);
  if (!BrowserIdentityKeySchema.safeParse(named).success || (named !== DEFAULT_BROWSER_IDENTITY && !configured))
    throw new ApiError(404, `there is no browser identity named ${named}`, 'not_found');
  return named;
}

/**
 * Settings › Browsers › Identities (G4 U4): the identities as the daemon knows them, and stopping ONE. A stop closes
 * only that identity's Chrome and pages and keeps its profile folder, so every sign-in on it is still there when it
 * next opens. Adding an identity is not here: it is a write of `browsers.yaml` through the config proposal path.
 */
export function identityRoutes(listing: IdentityListing) {
  return {
    'GET /v1/browser/identities': (async () => jsonResponse(await identitiesView(listing))) satisfies RouteHandler,
    'POST /v1/browser/identities/:identity/stop': (async call => {
      const identity = stoppable(listing, call);
      await listing.stop(identity);
      return jsonResponse(await rowOf(listing, listing.config(), identity));
    }) satisfies RouteHandler,
  } as const;
}
