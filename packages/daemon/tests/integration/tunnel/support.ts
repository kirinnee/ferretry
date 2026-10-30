/**
 * Integration fixtures for the tunnel carrier: a fake `cloudflared` that is a real executable, and a
 * fake hosted provisioner that is a real HTTP server on loopback and verifies what it is sent with the
 * shared transcript code, over the host it is actually served on — the check the Worker makes.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NONCE_BYTES,
  type TunnelProvision,
  TunnelProvisionRequestSchema,
  TunnelReleaseRequestSchema,
  toBase64Url,
  verifyTunnelRequest,
} from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';

const directories: string[] = [];

export async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
  directories.push(directory);
  return directory;
}

export async function removeTempDirectories(): Promise<void> {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
}

/**
 * A stand-in for `cloudflared`, as a real executable. It records how it was started — its arguments,
 * the NAMES of the variables it inherited, and a DIGEST of the token it was given, never the token —
 * beside itself, then prints what a real connector prints. Its behaviour is read from a `mode` file
 * beside it rather than its environment, because the daemon hands it only an allowlisted environment:
 * `register` (default), `exit` (code 3), `exit:<code>`, `partial`, `stubborn`.
 */
const FAKE_CLOUDFLARED = `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
const token = process.env.TUNNEL_TOKEN ?? '';
appendFileSync(import.meta.dir + '/record.jsonl', JSON.stringify({
  argv: process.argv.slice(2),
  environment: Object.keys(process.env).sort(),
  tokenSha256: token === '' ? null : new Bun.CryptoHasher('sha256').update(token).digest('hex'),
  pid: process.pid,
}) + '\\n');
const mode = readFileSync(import.meta.dir + '/mode', 'utf8').trim();
process.stderr.write('2026-10-21T10:00:00Z INF Starting tunnel tunnelID=fake\\n');
if (mode.startsWith('exit')) process.exit(Number(mode.split(':')[1] ?? '3'));
if (mode === 'partial') {
  process.stderr.write('2026-10-21T10:00:01Z INF Registered tunnel connection connIndex=3');
  process.exit(0);
}
if (mode === 'stubborn') process.on('SIGTERM', () => {});
process.stderr.write('2026-10-21T10:00:01Z INF Registered tunnel connection connIndex=0 connection=fake event=0 ip=198.41.200.13 location=lhr01 protocol=quic\\n');
setInterval(() => {}, 1000);
`;

/** Writes the fake connector into a fresh directory as an executable named `cloudflared`. */
export async function fakeCloudflared(mode = 'register'): Promise<{ readonly path: string; readonly record: string }> {
  const directory = await tempDirectory('fake-cloudflared');
  const path = join(directory, 'cloudflared');
  await writeFile(path, FAKE_CLOUDFLARED);
  await writeFile(join(directory, 'mode'), mode);
  await chmod(path, 0o755);
  return { path, record: join(directory, 'record.jsonl') };
}

export interface ConnectorRecord {
  readonly argv: readonly string[];
  readonly environment: readonly string[];
  readonly tokenSha256: string | null;
  readonly pid: number;
}

export async function connectorRecords(record: string): Promise<ConnectorRecord[]> {
  const text = await readFile(record, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as ConnectorRecord);
}

export function sha256(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

export { waitFor } from '../support/wait-for.ts';

const crypto_ = new WebCryptoRelayCrypto();

/** The hosted service, faked on loopback. Every signed request is verified over the host it arrived on. */
export class FakeHostedService {
  readonly origin: string;
  readonly paths: string[] = [];
  readonly provisions: { readonly originPort: number; readonly daemonId: string }[] = [];
  readonly releases: string[] = [];
  readonly verdicts: boolean[] = [];
  available = true;
  provision: (originPort: number) => TunnelProvision = () => ({
    version: 1,
    tunnelUrl: 'https://quiet-otter.tunnels.example',
    connectorToken: 'fake-connector-token-INTEGRATION',
    renewAfterSeconds: 86_400,
  });
  readonly #nonces = new Map<string, Uint8Array>();
  readonly #server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.#server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async request => await this.#answer(request),
    });
    this.origin = `http://127.0.0.1:${String(this.#server.port)}`;
  }

  async stop(): Promise<void> {
    await this.#server.stop(true);
  }

  async #answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    this.paths.push(`${request.method} ${url.pathname}`);
    if (url.pathname === '/v1/tunnel-service')
      return Response.json({ version: 1, available: this.available }, { headers: { 'cache-control': 'no-store' } });
    const body = (await request.json()) as Record<string, unknown>;
    if (url.pathname === '/v1/tunnel/challenge') {
      const nonce = crypto_.randomBytes(NONCE_BYTES);
      this.#nonces.set(String(body.daemonId), nonce);
      return Response.json({ version: 1, nonce: toBase64Url(nonce), deadlineSeconds: 60 });
    }
    const action = url.pathname === '/v1/tunnel/provision' ? 'provision' : 'release';
    const parsed =
      action === 'provision' ? TunnelProvisionRequestSchema.parse(body) : TunnelReleaseRequestSchema.parse(body);
    const nonce = this.#nonces.get(parsed.daemonId) ?? new Uint8Array();
    this.#nonces.delete(parsed.daemonId);
    const originPort = 'originPort' in parsed ? (parsed.originPort as number) : undefined;
    const verdict = await verifyTunnelRequest(
      crypto_,
      {
        action,
        daemonId: parsed.daemonId,
        // ITS OWN host, as the Worker rebuilds the transcript — never the request's claim.
        host: url.host,
        nonce,
        ...(originPort === undefined ? {} : { originPort }),
      },
      parsed,
    );
    this.verdicts.push(verdict.ok);
    if (!verdict.ok)
      return Response.json({ error: { code: 'tunnel_claim_rejected', message: verdict.reason } }, { status: 401 });
    if (originPort === undefined) {
      this.releases.push(parsed.daemonId);
      return Response.json({ version: 1, released: true });
    }
    this.provisions.push({ originPort, daemonId: parsed.daemonId });
    return Response.json(this.provision(originPort));
  }
}
