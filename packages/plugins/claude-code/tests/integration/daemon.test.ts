import { describe, expect, test } from 'bun:test';
import { device, ferret, owner, testHost } from '@ferretry/kernel/testing';
import daemon from '../../daemon/index.ts';

/** A machine with no claude on it, a tmux that records what it is told, and a pane that shows `frame`. */
function machine(frame: string | undefined) {
  const typed: string[][] = [];
  const spawn = async (program: string, args: readonly string[]) => {
    const done = (exitCode: number, stdout = '') => ({ exitCode, signal: null, stdout, stderr: '' });
    if (program === 'printenv') return done(0, '/home/kirin\n');
    if (program === 'uname') return done(0, 'Linux\n');
    if (program === 'tmux') {
      if (args[0] === 'capture-pane') return done(frame === undefined ? 1 : 0, frame ?? '');
      typed.push([...args]);
      return done(0);
    }
    return done(1);
  };
  return { typed, spawn };
}

const read = async (name: string): Promise<string> =>
  await Bun.file(`${import.meta.dir}/../fixtures/${name}.txt`).text();

describe('claude-code daemon half', () => {
  test('G31 the permission answer is a person act: a ferret asking for it is refused before anything is read', async () => {
    const { spawn, typed } = machine(await read('permission-prompts/claude-2.1.220-bash'));
    const host = await testHost({ plugins: [daemon], spawn });

    const response = await host.request('POST', '/v1/ferrets/f1/permission', {
      body: { kind: 'deny', requestId: '0123456789abcdef' },
      as: ferret('f2'),
    });

    expect(response.status).toBe(403);
    expect(typed).toEqual([]);
  });

  test('G31 an answer for a ferret whose pane is not known sends nothing and says why, and never echoes the choice', async () => {
    const { spawn, typed } = machine(await read('permission-prompts/claude-2.1.220-bash'));
    const host = await testHost({ plugins: [daemon], spawn });

    const response = await host.request('POST', '/v1/ferrets/f1/permission', {
      body: { kind: 'choice', requestId: '0123456789abcdef', number: 2 },
      as: owner(),
    });

    expect(response.status).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('pane_unknown');
    expect(response.body).not.toContain('"number"');
    expect(typed).toEqual([]);
  });

  test('G31 a body that is not an answer is refused with a 400 before any pane is touched', async () => {
    const { spawn, typed } = machine(undefined);
    const host = await testHost({ plugins: [daemon], spawn });

    const response = await host.request('POST', '/v1/ferrets/f1/permission', {
      body: { kind: 'choice', requestId: 'not-a-digest', number: 2 },
      as: owner(),
    });

    expect(response.status).toBe(400);
    expect(typed).toEqual([]);
  });

  test('G32 the harness-dialog answer is a person act and an unknown pane is refused, sending nothing', async () => {
    const { spawn, typed } = machine(await read('harness-dialogs/claude-2.1.220-settings-error'));
    const host = await testHost({ plugins: [daemon], spawn });

    const byFerret = await host.request('POST', '/v1/ferrets/f1/dialog', {
      body: { kind: 'escape', dialogId: '0123456789abcdef' },
      as: ferret('f2'),
    });
    const byOwner = await host.request('POST', '/v1/ferrets/f1/dialog', {
      body: { kind: 'escape', dialogId: '0123456789abcdef' },
      as: owner(),
    });

    expect(byFerret.status).toBe(403);
    expect(byOwner.status).toBe(409);
    expect(byOwner.json<{ code: string }>().code).toBe('pane_unknown');
    expect(typed).toEqual([]);
  });

  test('the update view says plainly that claude is not on this machine', async () => {
    const { spawn } = machine(undefined);
    const host = await testHost({ plugins: [daemon], spawn, fetch: async () => new Response('{}', { status: 404 }) });

    const response = await host.request('GET', '/v1/claude-code/update', { as: device('d1') });

    expect(response.status).toBe(200);
    const view = response.json<{ harness: string; location: { state: string }; method: unknown; plan: unknown }>();
    expect(view.harness).toBe('claude-code');
    expect(view.location.state).toBe('absent');
    expect(view.method).toBeNull();
    expect(view.plan).toBeNull();
  });

  test('G25 a ferret may never start an update', async () => {
    const { spawn } = machine(undefined);
    const host = await testHost({ plugins: [daemon], spawn });

    const response = await host.request('POST', '/v1/claude-code/update', { body: {}, as: ferret('f1') });

    expect(response.status).toBe(403);
  });

  test('starting an update with nothing located is a 409 with its code', async () => {
    const { spawn } = machine(undefined);
    const host = await testHost({ plugins: [daemon], spawn, fetch: async () => new Response('{}', { status: 404 }) });

    const response = await host.request('POST', '/v1/claude-code/update', { body: {}, as: owner() });

    expect(response.status).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('harness_update_not_located');
  });

  test('the claude-code port answers the same view and records what discovery found', async () => {
    const { spawn } = machine(undefined);
    const host = await testHost({ plugins: [daemon], spawn, fetch: async () => new Response('{}', { status: 404 }) });
    const { ClaudeCodePort, CLAUDE_CODE_DISCOVERY } = await import('../../contract/index.ts');
    const port = host.provided(ClaudeCodePort);

    expect(host.state('claude-code').raw(CLAUDE_CODE_DISCOVERY)).toBeUndefined();
    const view = await port.view();
    const recorded = JSON.parse(host.state('claude-code').raw(CLAUDE_CODE_DISCOVERY) as string);

    expect(view.location.state).toBe('absent');
    expect(recorded).toMatchObject({ format: 1, location: view.location, installed: null, method: null });
  });
});
