import { describe, expect, test } from 'bun:test';
import { ferret, owner, testHost } from '@ferretry/kernel/testing';
import { CodexPort } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';

/** A machine: `which codex` answers with `path` (or nothing); every other program fails. */
function machine(options: { readonly path?: string }) {
  const asked: string[] = [];
  const spawn = async (program: string, args: readonly string[]) => {
    asked.push([program, ...args].join(' '));
    const done = (exitCode: number, stdout = '') => ({ exitCode, signal: null, stdout, stderr: '' });
    if (program === 'printenv') return done(0, args[0] === 'HOME' ? '/home/kirin\n' : '/usr/bin\n');
    if (program === 'uname') return done(0, 'Linux\n');
    if (program === 'which') return options.path === undefined ? done(1) : done(0, `${options.path}\n`);
    if (program === 'test') return done(options.path === undefined ? 1 : 0);
    if (program === 'realpath') return done(0, `${args[0] ?? ''}\n`);
    if (program === 'readlink') return done(1);
    return done(1);
  };
  return { asked, spawn };
}

const npmLatest = async () =>
  new Response(JSON.stringify({ version: '0.145.0' }), { headers: { 'content-type': 'application/json' } });

describe('codex daemon half', () => {
  test('the update view says plainly that codex is not on this machine', async () => {
    const { spawn } = machine({});
    const host = await testHost({ plugins: [daemon], spawn, fetch: npmLatest });

    const response = await host.request('GET', '/v1/codex/update', { as: owner() });

    expect(response.status).toBe(200);
    const view = response.json<{ harness: string; location: { state: string }; installed: unknown; available: boolean }>();
    expect(view.harness).toBe('codex');
    expect(view.location.state).toBe('absent');
    expect(view.installed).toBeNull();
    expect(view.available).toBe(false);
  });

  test('the update view finds codex where the host says it is, and records what discovery found', async () => {
    const { spawn } = machine({ path: '/opt/bin/codex' });
    const host = await testHost({ plugins: [daemon], spawn, fetch: npmLatest });

    const response = await host.request('GET', '/v1/codex/update', { as: owner() });

    expect(response.status).toBe(200);
    const view = response.json<{ location: { state: string; path: string; rule: string } }>();
    expect(view.location).toMatchObject({ state: 'located', path: '/opt/bin/codex', rule: 'inherited environment' });
    const found = await host.provided(CodexPort).discovery();
    expect(found?.location).toEqual(view.location);
  });

  test('a ferret may not start an update, and nothing is run for it', async () => {
    const { spawn, asked } = machine({ path: '/opt/bin/codex', version: '0.140.0' });
    const host = await testHost({ plugins: [daemon], spawn, fetch: npmLatest });

    const response = await host.request('POST', '/v1/codex/update', { body: {}, as: ferret('f1') });

    expect(response.status).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('owner_only');
    expect(asked.filter(line => line.startsWith('npm') || line.startsWith('brew'))).toEqual([]);
  });

  test('a body that is not an update request is refused with a 400', async () => {
    const { spawn } = machine({ path: '/opt/bin/codex' });
    const host = await testHost({ plugins: [daemon], spawn, fetch: npmLatest });

    const response = await host.request('POST', '/v1/codex/update', { body: { target: 5 }, as: owner() });

    expect(response.status).toBe(400);
    expect(response.json<{ code: string }>().code).toBe('invalid_request');
  });

  test('an update with no codex to update is a 409 that names why', async () => {
    const { spawn } = machine({});
    const host = await testHost({ plugins: [daemon], spawn, fetch: npmLatest });

    const response = await host.request('POST', '/v1/codex/update', { body: {}, as: owner() });

    expect(response.status).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('harness_update_not_located');
  });
});
