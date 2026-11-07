import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { jsonResponse, textResponse } from '../../../contract/http.ts';
import type { ApiRequest } from '../../../contract/http.ts';
import { DaemonRunSchema } from '../../../contract/run.ts';
import type { Listening, RunningHost } from '../../../host/host.ts';
import {
  isLoopbackPeer,
  listenLocal,
  recordedBindAddress,
  runBindPath,
  runSocketPath,
  toResponse,
} from '../../../host/listener.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** A host whose dispatch echoes the arrival the listener decided. */
function echoHost(seen: ApiRequest[]): RunningHost {
  return {
    dispatch: async (request: ApiRequest) => {
      seen.push(request);
      return jsonResponse({ arrival: request.arrival, clientAddress: request.clientAddress ?? null });
    },
    dispatcher: { upgrade: async () => ({ outcome: 'unclaimed' }) },
  } as unknown as RunningHost;
}

async function listening(seen: ApiRequest[]): Promise<{ home: string; listener: Listening }> {
  const home = await mkdtemp(`${tmpdir()}/fy-l-`);
  await Bun.write(`${home}/run/.keep`, '');
  const listener = await listenLocal(echoHost(seen), {
    home,
    port: 0,
    pid: 4242,
    version: '5.0.0',
    write: (path, text) => writeFile(path, text, { mode: 0o600 }),
    chmod: (path, mode) => chmod(path, mode),
    remove: path => rm(path, { force: true }),
  });
  cleanup.push(async () => {
    await listener.stop();
    await rm(home, { recursive: true, force: true });
  });
  return { home, listener };
}

describe('the local listener (§2.2, §4.8)', () => {
  test('G14 local arrival is decided by the listener from the real socket peer, never from a header', async () => {
    const seen: ApiRequest[] = [];
    const { home } = await listening(seen);
    const bind = JSON.parse(await readFile(runBindPath(home), 'utf8')) as { host: string; port: number };
    const response = await fetch(`${recordedBindAddress(bind)}/v1/anything`, {
      headers: { 'x-forwarded-for': '203.0.113.9', forwarded: 'for=203.0.113.9', host: 'evil.example' },
    });
    const body = (await response.json()) as { arrival: { kind: string; privileged: boolean }; clientAddress: string };
    expect(body.arrival).toEqual({ kind: 'local', privileged: true });
    expect(isLoopbackPeer(body.clientAddress)).toBe(true);
    const viaSocket = await fetch('http://localhost/v1/x', { unix: runSocketPath(home) } as RequestInit);
    expect(((await viaSocket.json()) as { arrival: { kind: string } }).arrival.kind).toBe('local');
  });

  test('G14 a non-loopback peer is never local', () => {
    expect(isLoopbackPeer('203.0.113.9')).toBe(false);
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('10.0.0.1')).toBe(false);
    expect(isLoopbackPeer('::1')).toBe(true);
  });

  test('P89 a local client dials the recorded bind; a wildcard bind resolves to loopback at the recorded port', async () => {
    expect(recordedBindAddress({ host: '0.0.0.0', port: 7457 })).toBe('http://127.0.0.1:7457');
    expect(recordedBindAddress({ host: '::', port: 7457 })).toBe('http://127.0.0.1:7457');
    expect(recordedBindAddress({ host: '127.0.0.1', port: 9 })).toBe('http://127.0.0.1:9');
    const { home } = await listening([]);
    const bind = DaemonRunSchema.parse(JSON.parse(await readFile(runBindPath(home), 'utf8')));
    expect(bind).toMatchObject({ format: 1, pid: 4242, version: '5.0.0', socket: runSocketPath(home) });
    expect(runBindPath(home)).toBe(`${home}/run/daemon.json`);
    expect(bind.port).toBeGreaterThan(0);
  });

  test('the Unix socket is owner-only', async () => {
    const { home } = await listening([]);
    expect((await Bun.file(runSocketPath(home)).stat()).mode & 0o777).toBe(0o600);
  });

  test('I74 the final check is the last synchronous step before bytes leave: late decides at toResponse', () => {
    let held = false;
    const response = {
      ...textResponse('masked body'),
      late: () => (held ? textResponse('withheld', 409) : textResponse('masked body')),
    };
    held = true;
    const sent = toResponse(response, false);
    expect(sent.status).toBe(409);
  });

  test('an oversized body is refused piece by piece', async () => {
    const home = await mkdtemp(`${tmpdir()}/fy-l-`);
    await Bun.write(`${home}/run/.keep`, '');
    let refused = '';
    const host = {
      dispatch: async (request: ApiRequest) => {
        try {
          await request.text(8);
        } catch (error) {
          refused = (error as { code?: string }).code ?? '';
        }
        return jsonResponse({});
      },
      dispatcher: { upgrade: async () => ({ outcome: 'unclaimed' }) },
    } as unknown as RunningHost;
    const listener = await listenLocal(host, {
      home,
      port: 0,
      pid: 4242,
      version: '5.0.0',
      write: (path, text) => writeFile(path, text),
      chmod: (path, mode) => chmod(path, mode),
      remove: path => rm(path, { force: true }),
    });
    cleanup.push(async () => {
      await listener.stop();
      await rm(home, { recursive: true, force: true });
    });
    await fetch('http://localhost/v1/x', {
      method: 'POST',
      body: 'x'.repeat(64),
      unix: runSocketPath(home),
    } as RequestInit);
    expect(refused).toBe('body_too_large');
  });
});
