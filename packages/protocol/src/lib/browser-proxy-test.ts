import { z } from 'zod';
import { BrowserLifecycleSchema, BrowserProxySettingSchema, BrowserProxyStatusSchema } from './browser.ts';
import { InstantSchema, NonNegativeIntegerSchema } from './common.ts';

/** The daemon-wide "Test proxy" route (docs/browser-proxy.md § Test proxy). POST only; owner only. */
export const BROWSER_PROXY_TEST_PATH = '/v1/browser/proxy/test';
/** The machine's one agent browser as a whole: whether it runs and which proxy it started with. */
export const BROWSER_STATE_PATH = '/v1/browser/state';

/**
 * What a proxy test asks for. `proxy` is the setting to try — typically the one being edited and not yet
 * saved — and ABSENT means the saved one. A setting holds `${secret:NAME}` references and never a value,
 * so a request cannot carry a credential; the daemon resolves the names from its own secret store.
 */
export const BrowserProxyTestRequestSchema = z.strictObject({
  proxy: BrowserProxySettingSchema.optional(),
});
export type BrowserProxyTestRequest = z.infer<typeof BrowserProxyTestRequestSchema>;

/**
 * Why a test did not get an answer through the proxy.
 *
 * - `dns` — the proxy's own host name did not resolve, or the proxy could not resolve the test endpoint.
 * - `connect` — nothing accepted a connection at the proxy's address (refused, unreachable, reset).
 * - `auth` — the proxy answered 407 or refused the user name and password.
 * - `tls` — the secure connection to the test endpoint (or to an `https://` proxy) failed.
 * - `timeout` — no answer within the test's limit.
 * - `proxy` — the proxy answered, but with a refusal or something that is not a proxy reply.
 * - `secret` — a secret the setting names is not in this machine's store, so nothing was attempted.
 * - `no-proxy` — no proxy is saved and none was given: there is nothing to test.
 * - `other` — anything else; the sentence says what it can.
 */
export const BROWSER_PROXY_ERROR_CLASSES = [
  'dns',
  'connect',
  'auth',
  'tls',
  'timeout',
  'proxy',
  'secret',
  'no-proxy',
  'other',
] as const;
export const BrowserProxyErrorClassSchema = z.enum(BROWSER_PROXY_ERROR_CLASSES);
export type BrowserProxyErrorClass = z.infer<typeof BrowserProxyErrorClassSchema>;

const EgressAddressSchema = z.union([z.ipv4(), z.ipv6()]);

const TestedSchema = z.enum(['saved', 'unsaved']);

/**
 * What a test found. It carries no credential, no header, no address of the proxy and no URL: `message` is
 * one sentence the daemon wrote, and `egressIp` is the address the test endpoint saw the request come from,
 * which is the proxy's when the proxy works.
 */
export const BrowserProxyTestResultSchema = z.discriminatedUnion('reachable', [
  z.strictObject({
    reachable: z.literal(true),
    tested: TestedSchema,
    roundTripMs: NonNegativeIntegerSchema,
    egressIp: EgressAddressSchema,
    message: z.string().min(1).max(400),
  }),
  z.strictObject({
    reachable: z.literal(false),
    tested: TestedSchema,
    errorClass: BrowserProxyErrorClassSchema,
    roundTripMs: NonNegativeIntegerSchema.optional(),
    message: z.string().min(1).max(400),
  }),
]);
export type BrowserProxyTestResult = z.infer<typeof BrowserProxyTestResultSchema>;

/** The machine's agent browser as a whole, for the Browser section's status line. */
export const BrowserStateViewSchema = z.strictObject({
  state: BrowserLifecycleSchema,
  startedAt: InstantSchema.optional(),
  /** The proxy the RUNNING browser started with; absent when it is stopped or goes direct. */
  proxy: BrowserProxyStatusSchema.optional(),
});
export type BrowserStateView = z.infer<typeof BrowserStateViewSchema>;
