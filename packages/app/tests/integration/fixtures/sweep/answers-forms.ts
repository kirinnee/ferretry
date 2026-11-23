/**
 * The fake machine's WRITES for the settings forms (C59 O8-10 fix round): a PATCH answers with the shape the app's own response schema
 * accepts (never `{ ok: true }`, which a real client refuses), and what it wrote is KEPT in this browser's `localStorage`, so a reload reads the
 * saved value back, exactly as a real machine would. Nothing here is a real home, login or key.
 *
 * A test steers the fake from its page, before load (`addInitScript`) or live:
 *   fyFake.security          JSON of settings to start from, over the sweep's own (`{"unlockOnOpen":false}`)
 *   fyFake.refuseSecurity    '1': a Security PATCH is refused (a machine that says no)
 *   window.__fyHoldWrites()  from here on a write waits until `window.__fyReleaseWrites()` (a Save that is still in flight)
 */
import type { TransportAnswer, TransportRequest } from '../../../../src/client/transport.ts';
import { json } from '../../../unit/client/fixtures.ts';
import { security } from '../access-settings-data.ts';
import { answer as answerB } from './answers-b.ts';

const SECURITY = 'fyFake.security';
const WARDEN = 'fyFake.warden';

const stored = (key: string): Record<string, unknown> => {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw === null || raw === undefined ? {} : (JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return {};
  }
};
const keep = (key: string, value: unknown): void => {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // a browser with no storage: the write is simply not kept
  }
};
const flag = (key: string): boolean => {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
};
const bodyOf = (request: TransportRequest): Record<string, unknown> => {
  const body = request.body;
  const parsed = typeof body === 'string' ? JSON.parse(body) : body;
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** A PATCH body laid over what is there: objects merge key by key, everything else (arrays, numbers) is replaced. */
const merge = (base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const before = out[key];
    out[key] = isRecord(value) && isRecord(before) ? merge(before, value) : value;
  }
  return out;
};

/** A write that is held (`__fyHoldWrites`) waits here until the test lets it go. */
let held: Promise<void> | undefined;
let release: () => void = () => undefined;
const control = globalThis as unknown as { __fyHoldWrites?: () => void; __fyReleaseWrites?: () => void };
control.__fyHoldWrites = () => {
  held = new Promise<void>(resolve => {
    release = resolve;
  });
};
control.__fyReleaseWrites = () => release();

const securityView = () => ({ ...security, settings: { ...security.settings, ...stored(SECURITY) } });

const wardenView = (): Record<string, unknown> | undefined => {
  const base = answerB({ method: 'GET', path: '/v1/warden/config' } as TransportRequest);
  const view = base?.body as Record<string, unknown> | undefined;
  if (view === undefined) return undefined;
  return { ...view, config: merge(view.config as Record<string, unknown>, stored(WARDEN)) };
};

export const answerWrites = async (request: TransportRequest): Promise<TransportAnswer | undefined> => {
  const path = request.path.split('?')[0] ?? '';
  if (path === '/v1/security' && request.method === 'GET') return json(securityView());
  if (path === '/v1/security' && request.method === 'PATCH') {
    await held;
    if (flag('fyFake.refuseSecurity'))
      return json({ error: { code: 'internal', message: 'The machine could not save that.' } }, 500);
    keep(SECURITY, { ...stored(SECURITY), ...bodyOf(request) });
    return json({ view: securityView(), devicesExpiring: 0 });
  }
  if (path === '/v1/warden/config' && request.method === 'GET') return json(wardenView());
  if (path === '/v1/warden/config' && request.method === 'PATCH') {
    await held;
    keep(WARDEN, merge(stored(WARDEN), bodyOf(request)));
    return json(wardenView());
  }
  return undefined;
};
