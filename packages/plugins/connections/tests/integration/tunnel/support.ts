/**
 * Integration fixtures for the tunnel carrier: a fake `cloudflared` that is a real executable, and a
 * fake hosted provisioner that is a real HTTP server on loopback and verifies what it is sent with the
 * shared transcript code, over the host it is actually served on — the check the Worker makes.
 */

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directories: string[] = [];

async function tempDirectory(prefix: string): Promise<string> {
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
