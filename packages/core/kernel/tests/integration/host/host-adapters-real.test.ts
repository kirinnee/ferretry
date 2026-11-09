/**
 * The host's own adapters, on the real machine: a real child that outlives its parent, `run` over real pipes, fetch and
 * WebSocket against a server on the loopback interface, and the one that refuses every dial. Nothing leaves this host.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { bunSpawn, bunWebSockets, globalFetch, noWebSockets } from '../../../host/adapters/process.ts';

const spawn = bunSpawn({ PATH: process.env.PATH ?? '/usr/bin:/bin' });
const detachedPids: number[] = [];

afterAll(() => {
  for (const pid of detachedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

describe('kernel.spawn on the real machine', () => {
  test('run answers what a child printed on each stream and how it ended', async () => {
    const answer = await spawn.run('sh', ['-c', 'printf out; printf err >&2; exit 3']);

    expect(answer).toEqual({ exitCode: 3, signal: null, stdout: 'out', stderr: 'err' });
  });

  test('a detached child is a real process of its own, whose handle is closed and cannot be killed through', async () => {
    const handle = spawn.start('sleep', ['30'], { detached: true });
    detachedPids.push(handle.pid);

    expect(handle.pid).toBeGreaterThan(0);
    expect(() => process.kill(handle.pid, 0)).not.toThrow();
    expect(await handle.exited).toBeNull();
    expect(() => handle.kill()).toThrow();
    expect(() => handle.write('x')).toThrow();
  });

  test('a detached child is only ever started, never run or read as bytes', async () => {
    await expect(spawn.run('sleep', ['1'], { detached: true })).rejects.toThrow('started with start');
    await expect(spawn.runBytes('sleep', ['1'], { detached: true })).rejects.toThrow('started with start');
  });
});

describe('the host’s network adapters, against a server on the loopback interface', () => {
  test('globalFetch asks the real network stack and answers the real reply', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('hello from loopback') });
    try {
      const reply = await globalFetch().request(`http://127.0.0.1:${String(server.port)}/`);

      expect(await reply.text()).toBe('hello from loopback');
    } finally {
      await server.stop(true);
    }
  });

  test('bunWebSockets dials the URL it is given and nothing more', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, serving) => (serving.upgrade(request) ? undefined : new Response('no', { status: 400 })),
      websocket: {
        message: (socket, message) => {
          socket.send(`echo:${String(message)}`);
        },
      },
    });
    try {
      const client = bunWebSockets().connect(`ws://127.0.0.1:${String(server.port)}/`);
      const received = await new Promise<string>((resolve, reject) => {
        client.onopen = () => client.send('ping');
        client.onmessage = event => resolve(String(event.data));
        client.onerror = () => reject(new Error('the loopback socket failed'));
      });
      client.close();

      expect(received).toBe('echo:ping');
    } finally {
      await server.stop(true);
    }
  });

  test('a host without WebSockets refuses every dial, so a test can never reach the network by accident', () => {
    expect(() => noWebSockets().connect('ws://127.0.0.1:1/')).toThrow('opens no WebSocket connections');
  });
});
