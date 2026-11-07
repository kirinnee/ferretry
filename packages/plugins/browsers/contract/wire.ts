/**
 * Browsers' wire (§2.1), copied field for field from today's `packages/protocol/src/lib/{browser,browser-login,
 * browser-proxy-test,loopback-firewall,surface,surface-names}.ts`. The page snapshot, action and per-tool call
 * schemas (`browser-target.ts`, `browser-pointer.ts`, `browser-page-lifecycle.ts`, the `browser.*` calls of
 * `agent-tools.ts`) are copied by the port with the code that answers them. Page text never appears here: it
 * leaves only through an act (`kernel.act`) under `Redaction.read` and the final check (§7.3).
 */
import { InstantSchema, NonNegativeIntegerSchema } from '@ferretry/std';
import { z } from 'zod';
import { SECRET_REFERENCE_SOURCE } from '@ferretry/core-vault/contract';

// ─── surfaces (Terminals keeps its own copy; there is no contract edge between the two) ──────────────────────────

export const SURFACE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;

export const SurfaceNameSchema = z
  .string()
  .regex(SURFACE_NAME_PATTERN, 'a name is a lowercase letter, then up to 31 lowercase letters, digits or dashes')
  .refine(value => !/^[a-f0-9]{12}$/u.test(value), 'a name may not look like a terminal id (twelve hex characters)');

/** A page's name or id; a `%browser:` reference prefix is read through (`docs/reference-standard.md`). */
export const SurfaceKeySchema = z
  .string()
  .trim()
  .transform(value => value.replace(/^%(?:terminal|browser):/u, ''))
  .pipe(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u, 'not a surface name or id'));

/** `POST /v1/sessions/:sessionId/surfaces/browser/control`: take over (the WHOLE browser), hand back, hand over. */
export const SurfaceControlRequestSchema = z.strictObject({
  action: z.enum(['takeover', 'handback', 'handover']),
  key: SurfaceKeySchema,
});
export type SurfaceControlRequest = z.infer<typeof SurfaceControlRequestSchema>;

// ─── the browser ──────────────────────────────────────────────────────────────────────────────────────────────────

export const BROWSER_MAX_INSTANCES = 3;
export const BROWSER_MAX_PAGES = 20;
export const BROWSER_MAX_MACHINE_PAGES = 60;
export const BROWSER_MAX_PAGE_ID_LENGTH = 128;

export const BrowserLifecycleSchema = z.enum(['stopped', 'starting', 'running', 'stopping', 'error']);
export type BrowserLifecycle = z.infer<typeof BrowserLifecycleSchema>;
export const BrowserActorKindSchema = z.enum(['agent', 'human']);
export const BrowserProfileKindSchema = z.enum(['shared', 'session']);
export const BrowserPageStateSchema = z.enum(['loading', 'ready', 'error']);
export const BrowserModeSchema = z.enum(['headless', 'window']);
export type BrowserMode = z.infer<typeof BrowserModeSchema>;

export const BrowserPageIdSchema = z.string().min(1).max(BROWSER_MAX_PAGE_ID_LENGTH);

// ─── the proxy ────────────────────────────────────────────────────────────────────────────────────────────────────

export const BROWSER_PROXY_SCHEMES = ['http', 'https', 'socks5'] as const;
export const BROWSER_PROXY_MAX_BYPASS = 64;

export function browserProxyUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'a proxy address looks like http://host:8080, https://host:8443 or socks5://host:1080';
  }
  const scheme = url.protocol.slice(0, -1);
  if (!(BROWSER_PROXY_SCHEMES as readonly string[]).includes(scheme))
    return 'a proxy address starts with http://, https:// or socks5://';
  if (url.hostname === '') return 'a proxy address needs a host';
  if (url.username !== '' || url.password !== '')
    return 'a proxy address never carries a user name or password: set username and password to ${secret:NAME} references instead';
  if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '')
    return 'a proxy address is only a scheme, a host and a port';
  return undefined;
}

const BROWSER_PROXY_BYPASS_ENTRY = /^[A-Za-z0-9*._:/<>[\]-]{1,253}$/u;

const BrowserProxySecretReferenceSchema = z
  .string()
  .regex(
    new RegExp(`^${SECRET_REFERENCE_SOURCE}$`, 'u'),
    'proxy credentials are written as a ${secret:NAME} reference to the secret store, never as the value',
  );

export const BrowserProxySettingSchema = z
  .strictObject({
    url: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .superRefine((value, context) => {
        const problem = browserProxyUrlProblem(value);
        if (problem !== undefined) context.addIssue({ code: 'custom', message: problem });
      }),
    bypass: z
      .array(
        z
          .string()
          .trim()
          .regex(
            BROWSER_PROXY_BYPASS_ENTRY,
            'a bypass entry is a host, a *.domain pattern, an address range such as 10.0.0.0/8, or <local>',
          ),
      )
      .max(BROWSER_PROXY_MAX_BYPASS)
      .default([]),
    username: BrowserProxySecretReferenceSchema.optional(),
    password: BrowserProxySecretReferenceSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.username === undefined) !== (value.password === undefined))
      context.addIssue({
        code: 'custom',
        message: 'a proxy with credentials needs both username and password, each a ${secret:NAME} reference',
        path: [value.username === undefined ? 'username' : 'password'],
      });
  });
export type BrowserProxySetting = z.infer<typeof BrowserProxySettingSchema>;

export const BrowserProxyStatusSchema = z.strictObject({
  url: z.string().min(1).max(512),
  authenticated: z.boolean(),
  bypassCount: NonNegativeIntegerSchema,
});
export type BrowserProxyStatus = z.infer<typeof BrowserProxyStatusSchema>;

/** `POST /v1/browser/proxy/test`: the saved proxy, or one not yet saved. */
export const BrowserProxyTestRequestSchema = z.strictObject({ proxy: BrowserProxySettingSchema.optional() });
export type BrowserProxyTestRequest = z.infer<typeof BrowserProxyTestRequestSchema>;

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

const TestedSchema = z.enum(['saved', 'unsaved']);

/** Only whether it reached, how long it took and the error class: never an address, a header or a credential. */
export const BrowserProxyTestResultSchema = z.discriminatedUnion('reachable', [
  z.strictObject({
    reachable: z.literal(true),
    tested: TestedSchema,
    roundTripMs: NonNegativeIntegerSchema,
    egressIp: z.union([z.ipv4(), z.ipv6()]),
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

export const LOOPBACK_FIREWALL_STATES = ['applied', 'missing', 'stale', 'unverified', 'failed'] as const;
export const LoopbackFirewallStateSchema = z.strictObject({
  state: z.enum(LOOPBACK_FIREWALL_STATES),
  appliedAt: InstantSchema.optional(),
  /** One sentence for a person; for every state but `applied` it is the remedy. */
  detail: z.string().min(1).max(600),
});

/** `GET /v1/browser/state`. */
export const BrowserStateViewSchema = z.strictObject({
  state: BrowserLifecycleSchema,
  startedAt: InstantSchema.optional(),
  proxy: BrowserProxyStatusSchema.optional(),
  firewall: LoopbackFirewallStateSchema.optional(),
});
export type BrowserStateView = z.infer<typeof BrowserStateViewSchema>;

// ─── the human sign-in window (`GET|POST /v1/browser/login`) ──────────────────────────────────────────────────────

export const BrowserLoginStateSchema = z.enum(['closed', 'opening', 'open', 'closing', 'error']);
const NonBlankStringSchema = z.string().refine(value => value.trim() !== '', 'must not be blank');

/** How to reach the window over an SSH tunnel to this machine's loopback; its password is the window's own. */
export const BrowserLoginConnectionSchema = z.strictObject({
  host: z.literal('127.0.0.1'),
  port: z.number().int().min(1).max(65_535),
  password: NonBlankStringSchema,
  sshTunnel: NonBlankStringSchema,
});

const BrowserLoginStatusShape = { profilePrimed: z.boolean() };

export const BrowserLoginStatusSchema = z.discriminatedUnion('state', [
  z.strictObject({ ...BrowserLoginStatusShape, state: z.literal('closed') }),
  z.strictObject({ ...BrowserLoginStatusShape, state: z.literal('opening') }),
  z.strictObject({
    ...BrowserLoginStatusShape,
    state: z.literal('open'),
    openedAt: InstantSchema,
    expiresAt: InstantSchema,
    connection: BrowserLoginConnectionSchema,
  }),
  z.strictObject({
    ...BrowserLoginStatusShape,
    state: z.literal('closing'),
    openedAt: InstantSchema,
    expiresAt: InstantSchema,
  }),
  z.strictObject({ ...BrowserLoginStatusShape, state: z.literal('error'), error: NonBlankStringSchema.optional() }),
]);
export type BrowserLoginStatus = z.infer<typeof BrowserLoginStatusSchema>;

export const BrowserLoginActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('start'), minutes: z.number().int().min(1).max(60).optional() }),
  z.strictObject({ action: z.literal('stop'), primed: z.boolean().optional() }),
  z.strictObject({ action: z.literal('confirm') }),
]);
export type BrowserLoginAction = z.infer<typeof BrowserLoginActionSchema>;

// ─── config/browsers.yaml ─────────────────────────────────────────────────────────────────────────────────────────

/** How the agent browser runs and where it egresses. Credentials only as `${secret:NAME}`; no edit widens authority. */
export const BrowsersConfigSchema = z.strictObject({
  mode: BrowserModeSchema.default('headless'),
  proxy: BrowserProxySettingSchema.optional(),
});
export type BrowsersConfig = z.infer<typeof BrowsersConfigSchema>;

// ─── handing a link to this computer's own browser (today's `protocol/src/lib/open-url.ts`) ─────────────────────────

/** The longest address the daemon will hand to the operating system. */
export const OPEN_URL_MAX_LENGTH = 2048 as const;

/**
 * `POST /v1/system/open-url`. The schema only bounds the shape: what counts as an openable address (http or https, no
 * credentials) is the daemon's decision at its own boundary, because that is the one place a refusal protects anything.
 */
export const OpenUrlRequestSchema = z.strictObject({
  url: z.string().min(1).max(OPEN_URL_MAX_LENGTH),
});
export type OpenUrlRequest = z.infer<typeof OpenUrlRequestSchema>;

/** The answer carries the host and nothing else, so a link with a token in its query never travels back out. */
export const OpenUrlViewSchema = z.strictObject({
  opened: z.literal(true),
  host: z.string().min(1).max(253),
});
export type OpenUrlView = z.infer<typeof OpenUrlViewSchema>;
