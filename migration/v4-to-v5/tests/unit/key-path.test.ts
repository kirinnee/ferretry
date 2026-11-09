import { afterEach, beforeEach, expect, test } from 'bun:test';
import { daemonSettingsStep } from '../../src/steps/daemon-settings.ts';
import { keyPath, looksLikeKey, pathSegment } from '../../src/key-path.ts';
import { rawSecretPaths } from '../../src/v4/config.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

// Obviously fake: every value below is made up for the test.
const FAKE_KEYS = [
  'sk-FAKE0123',
  'sk-ant-FAKE0123',
  'ghp_FAKE0123',
  'gho_FAKE0123',
  'github_pat_FAKE0123',
  'xoxb-FAKE-0123',
  'AKIAFAKE0123',
  'FAKEKEYabcdefghij0123456789',
];

test('n1a a segment that looks like a key prints as <key>; ordinary names print as they are', () => {
  for (const key of FAKE_KEYS) {
    expect(looksLikeKey(key)).toBe(true);
    expect(pathSegment(key)).toBe('<key>');
  }
  for (const name of [
    'env',
    'maxSessionsPerRun',
    'OPENAI_API_KEY',
    'a.b-c',
    'skills',
    'xml',
    '0',
    'abcdefghijklmnopqrstuvwxyz',
  ]) {
    expect(looksLikeKey(name)).toBe(false);
    expect(pathSegment(name)).toBe(name);
  }
  // 20+ token-alphabet characters need BOTH a letter and a digit.
  expect(looksLikeKey('abcdefghijklmnopqrst')).toBe(false);
  expect(looksLikeKey('01234567890123456789')).toBe(false);
  expect(looksLikeKey('abcdefghij0123456789')).toBe(true);
  expect(looksLikeKey('abcdefghij012345678')).toBe(false);
  expect(pathSegment(3)).toBe('3');
  expect(pathSegment('has space')).toBe('<key>');
  expect(keyPath([])).toBe('(top)');
  expect(keyPath(['servers', 'sk-FAKE0123', 2, 'args'])).toBe('servers.<key>.2.args');
});

test('n1a the older key-path sites use the same rule: raw-secret paths never print a key-shaped map key', () => {
  const paths = rawSecretPaths({ env: { 'sk-FAKE0123': 'sk-ant-FAKEFAKEFAKEFAKEFAKE0123' } });
  expect(paths.length).toBe(1);
  expect(paths[0]).toBe('env.<key>');
  expect(paths[0]).not.toContain('sk-FAKE');
});

test('n1a daemon.json: an unrecognized key written as a credential is named <key>, never printed', async () => {
  await f.put('config/daemon.json', { 'sk-FAKE0123456789abcdef': true, bogus: 1 });
  const report = await daemonSettingsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toContain('unrecognized_keys');
  expect(report.note).toContain('<key>');
  expect(report.note).toContain('bogus');
  expect(JSON.stringify(report)).not.toContain('sk-FAKE');
});
