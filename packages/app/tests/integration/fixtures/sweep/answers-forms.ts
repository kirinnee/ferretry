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

// ── Browser (C59 O8-10 PR 2): browsers.yaml kept across writes, secrets by name, a proxy test that fails or works on cue ──
//   fyFake.browsersYaml   the document `GET /v1/config/file?path=browsers.yaml` reads (a test seeds it; a PUT keeps what it wrote)
//   fyFake.secrets        JSON array of the secret NAMES filed on the fake machine (a POST adds one; a value is never kept)
//   fyFake.proxyTest      'ok' | anything else fails: what `POST /v1/browser/proxy/test` answers
const BROWSERS = 'fyFake.browsersYaml';
const SECRETS = 'fyFake.secrets';
const readText = (key: string): string | undefined => {
  try {
    return globalThis.localStorage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};
const secretNames = (): string[] => {
  try {
    return JSON.parse(readText(SECRETS) ?? '[]') as string[];
  } catch {
    return [];
  }
};

/**
 * voice.yaml, kept across writes like browsers.yaml. `fyFake.refuseVoice` = '1' makes a write fail (a machine that says no);
 * `fyFake.voiceYaml` seeds the document.
 */
const VOICE = 'fyFake.voiceYaml';
const voiceAnswer = (request: TransportRequest, path: string): TransportAnswer | undefined => {
  if (path !== '/v1/config/file') return undefined;
  if (request.method === 'GET' && request.query?.path === 'voice.yaml') {
    const text = readText(VOICE);
    return text === undefined
      ? undefined
      : json({ path: 'voice.yaml', exists: true, text, etag: `etag-${text.length}` });
  }
  if (request.method === 'PUT' && bodyOf(request).path === 'voice.yaml') {
    if (flag('fyFake.refuseVoice'))
      return json({ error: { code: 'internal', message: 'The machine could not save that.' } }, 500);
    try {
      globalThis.localStorage?.setItem(VOICE, String(bodyOf(request).text));
    } catch {
      // not kept
    }
    return json({ path: 'voice.yaml', etag: `etag-${String(bodyOf(request).text).length}`, outcome: 'applied' });
  }
  return undefined;
};

const browserAnswer = (request: TransportRequest, path: string): TransportAnswer | undefined => {
  const voice = voiceAnswer(request, path);
  if (voice !== undefined) return voice;
  if (path === '/v1/config/file' && request.method === 'GET' && request.query?.path === 'browsers.yaml') {
    const text = readText(BROWSERS);
    return text === undefined
      ? undefined
      : json({ path: 'browsers.yaml', exists: true, text, etag: `etag-${text.length}` });
  }
  if (path === '/v1/config/file' && request.method === 'PUT' && bodyOf(request).path === 'browsers.yaml') {
    try {
      globalThis.localStorage?.setItem(BROWSERS, String(bodyOf(request).text));
    } catch {
      // a browser with no storage: the write is simply not kept
    }
    return json({ path: 'browsers.yaml', etag: `etag-${String(bodyOf(request).text).length}`, outcome: 'applied' });
  }
  if (path === '/v1/secrets' && request.method === 'GET' && readText(SECRETS) !== undefined)
    return json({ health: 'ready', secrets: secretNames().map(name => ({ name })) });
  if (path === '/v1/secrets' && request.method === 'POST') {
    try {
      globalThis.localStorage?.setItem(SECRETS, JSON.stringify([...secretNames(), String(bodyOf(request).name)]));
    } catch {
      // not kept
    }
    return json({ name: String(bodyOf(request).name) });
  }
  if (path === '/v1/browser/proxy/test' && request.method === 'POST') {
    const tested = isRecord(bodyOf(request).proxy) ? 'unsaved' : 'saved';
    return json(
      readText('fyFake.proxyTest') === 'ok'
        ? { reachable: true, tested, roundTripMs: 120, egressIp: '203.0.113.7', message: 'The proxy answered.' }
        : {
            reachable: false,
            tested,
            errorClass: 'connect',
            message: 'Nothing is listening at proxy.example.test:8080.',
          },
    );
  }
  return undefined;
};

export const answerWrites = async (request: TransportRequest): Promise<TransportAnswer | undefined> => {
  const path = request.path.split('?')[0] ?? '';
  const browser = browserAnswer(request, path);
  if (browser !== undefined) return browser;
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
