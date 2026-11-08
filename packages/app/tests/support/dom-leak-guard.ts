import { afterEach } from 'bun:test';

/**
 * A TEST LEAVES NOTHING BEHIND. Preloaded by `bunfig.unit.toml`.
 *
 * `scripts/ci/test.sh` runs every unit file in ONE `bun test` process, and happy-dom registers once per
 * process: its `document` and its replacement globals outlive the file that asked for them. Two things
 * then reach files that never wanted a DOM, far from their cause:
 *
 * 1. NODES. A root one test mounts and never unmounts stays in `document.body`, and a later file's
 *    whole-page query reads it (a left-over command bar answered picker-combobox's
 *    `input[role="combobox"]`; a left-over inbox hint line failed answer-quickly's "closes on Esc").
 *    After every test, each root `mount` (dom.ts) or `render` (react.ts) made and nobody unmounted is
 *    unmounted inside `act`, so the effects, intervals and portals it started stop with it, and the body
 *    is emptied of whatever a test appended by hand.
 * 2. GLOBALS. happy-dom replaces `WebSocket`, `fetch`, `Request`, `Response`, `Headers`, `AbortController`,
 *    `AbortSignal` and `DOMException` with classes that cannot talk to a real server, be returned from
 *    `Bun.serve` or be handed to a native `Request`. The carrier-listener, tunnel and socket-transport files,
 *    which dial or serve a real socket, read "The subprotocol '[object Object]' is invalid" and "Expected a
 *    Response object"; the MCP launch-renewal files, which build native requests, silently lose their second
 *    token request; and once the native `AbortController` is back, its abort reason is a native
 *    `DOMException`, which is no `instanceof` happy-dom's (passkey-retry's G95 aborted read).
 *    The native ones are captured here, before any DOM registers, and put back after every test. No unit
 *    DOM file reaches a network (each hands its component a fake).
 *
 * It is an `afterEach`, not an `afterAll`: Bun runs a preload's `afterAll` once for the whole run, not once
 * per file. So a root is mounted INSIDE the test that uses it, never in a `beforeAll`.
 */
const network = [
  'fetch',
  'Request',
  'Response',
  'Headers',
  'WebSocket',
  'AbortController',
  'AbortSignal',
  'DOMException',
] as const;
const natives = network.map(name => [name, Reflect.get(globalThis, name)] as const);

afterEach(async () => {
  const live = (globalThis as { __ferretryLiveMounts?: Set<() => Promise<void>> }).__ferretryLiveMounts;
  for (const unmount of [...(live ?? [])]) await unmount();
  // A file may stand in its own `document` (Connections' page-signal fakes have no body): only a real body is emptied.
  if (typeof document !== 'undefined') document?.body?.replaceChildren?.();
  for (const [name, native] of natives) Reflect.set(globalThis, name, native);
});
