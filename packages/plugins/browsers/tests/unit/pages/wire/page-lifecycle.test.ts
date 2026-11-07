import { describe, it } from 'bun:test';
import should from 'should';
import * as lifecycle from '../../src/lib/browser-page-lifecycle.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const cases: SchemaCase[] = [
  { name: 'dialog action', schema: lifecycle.BrowserDialogActionSchema, value: 'accept' },
  { name: 'dialog type', schema: lifecycle.BrowserDialogTypeSchema, value: 'beforeunload' },
  {
    name: 'dialog info',
    schema: lifecycle.BrowserDialogInfoSchema,
    value: { type: 'prompt', message: 'What is your name?' },
  },
  { name: 'element state', schema: lifecycle.BrowserElementStateSchema, value: 'detached' },
  { name: 'load state', schema: lifecycle.BrowserLoadStateSchema, value: 'networkidle' },
  {
    name: 'wait condition',
    schema: lifecycle.BrowserWaitConditionSchema,
    value: { kind: 'element', target: { kind: 'ref', ref: 'e4' }, state: 'visible' },
  },
  { name: 'console level', schema: lifecycle.BrowserConsoleLevelSchema, value: 'warning' },
  { name: 'resource type', schema: lifecycle.BrowserResourceTypeSchema, value: 'xhr' },
  { name: 'request id', schema: lifecycle.BrowserRequestIdSchema, value: 'r12' },
  { name: 'permission', schema: lifecycle.BrowserEmulatedPermissionSchema, value: 'clipboard-write' },
  { name: 'viewport', schema: lifecycle.BrowserEmulatedViewportSchema, value: { width: 390, height: 844 } },
  { name: 'media', schema: lifecycle.BrowserEmulatedMediaSchema, value: { colorScheme: 'dark', print: true } },
  {
    name: 'geolocation',
    schema: lifecycle.BrowserEmulatedGeolocationSchema,
    value: { latitude: -33.9, longitude: 151.2, accuracy: 20 },
  },
  { name: 'network', schema: lifecycle.BrowserEmulatedNetworkSchema, value: { offline: true } },
  { name: 'locale', schema: lifecycle.BrowserLocaleSchema, value: 'zh-Hant-TW' },
  { name: 'timezone', schema: lifecycle.BrowserTimezoneSchema, value: 'America/Argentina/Buenos_Aires' },
  { name: 'emulation', schema: lifecycle.BrowserEmulationSchema, value: { reset: true } },
  {
    name: 'lifecycle request',
    schema: lifecycle.BrowserPageLifecycleRequestSchema,
    value: { op: 'wait', condition: { kind: 'time', ms: 500 }, timeoutMs: 1_000 },
  },
];

const request = (value: Record<string, unknown>): SchemaCase => ({
  name: JSON.stringify(value).slice(0, 60),
  schema: lifecycle.BrowserPageLifecycleRequestSchema,
  value,
});

describe('browser page lifecycle schemas', () => {
  it('should round-trip every public lifecycle schema', () => {
    assertRoundTrips(cases);
    assertCoversEverySchema(lifecycle, cases);
  });

  it('should accept each lifecycle operation in its smallest valid form', () => {
    // Arrange
    const requests = [
      { op: 'dialog', action: 'dismiss' },
      { op: 'dialog', action: 'accept', promptText: 'hadi' },
      { op: 'wait', condition: { kind: 'text', text: 'Welcome' }, timeoutMs: 25_000 },
      {
        op: 'wait',
        condition: { kind: 'element', target: { kind: 'selector', selector: '#a' }, state: 'hidden' },
        timeoutMs: 1,
      },
      { op: 'console' },
      { op: 'console', level: 'error', since: 0, limit: 500 },
      { op: 'network', action: 'list' },
      { op: 'network', action: 'get', id: 'r3' },
      { op: 'emulate', emulation: { cpuThrottle: 4 } },
    ];

    // Act
    const parsed = requests.map(value => lifecycle.BrowserPageLifecycleRequestSchema.safeParse(value).success);

    // Assert
    should(parsed.every(Boolean)).be.true();
  });

  it('should refuse a request that is unbounded, unknown or carries a field of another operation', () => {
    assertRejects([
      request({ op: 'dialog' }),
      request({
        op: 'dialog',
        action: 'accept',
        promptText: 'x'.repeat(lifecycle.BROWSER_DIALOG_PROMPT_MAX_CHARS + 1),
      }),
      request({ op: 'wait', condition: { kind: 'time', ms: 1 } }),
      request({ op: 'wait', condition: { kind: 'time', ms: 1 }, timeoutMs: lifecycle.BROWSER_WAIT_MAX_MS + 1 }),
      request({ op: 'wait', condition: { kind: 'time', ms: 0 }, timeoutMs: 100 }),
      request({ op: 'wait', condition: { kind: 'text', text: '' }, timeoutMs: 100 }),
      request({
        op: 'wait',
        condition: { kind: 'element', target: { kind: 'ref', ref: 'button' }, state: 'visible' },
        timeoutMs: 100,
      }),
      request({ op: 'wait', condition: { kind: 'load', state: 'idle' }, timeoutMs: 100 }),
      request({ op: 'console', limit: lifecycle.BROWSER_CONSOLE_MAX_LIMIT + 1 }),
      request({ op: 'console', level: 'trace' }),
      request({ op: 'network', action: 'delete' }),
      request({ op: 'network', action: 'get', id: '12' }),
      request({ op: 'network', action: 'list', body: true }),
      request({ op: 'emulate', emulation: {} }),
      request({ op: 'emulate', emulation: { userAgent: 'curl' } }),
      request({ op: 'emulate', emulation: { permissions: ['clipboard-read'] } }),
      request({ op: 'scroll' }),
    ]);
  });

  it('should never let an emulation name the user agent, a client hint or the clipboard read permission', () => {
    // Arrange
    const keys = Object.keys(lifecycle.BrowserEmulationShape);

    // Act
    const permissions: readonly string[] = lifecycle.BROWSER_EMULATED_PERMISSIONS;

    // Assert
    should(keys.some(key => /agent|header|hint|ua/iu.test(key))).be.false();
    should(permissions.some(permission => permission.includes('clipboard-read'))).be.false();
    should(permissions.some(permission => permission === 'camera' || permission === 'microphone')).be.false();
  });
});
