import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHomePort } from '../../src/adapters/daemon/run-file.ts';

/**
 * fy's address fallback (no run record yet) is the port the daemon has IN EFFECT — the configuration service's accepted
 * record — never the text on disk, which may be an edit still held for the owner (review batch D, P1 security).
 */
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const text = (port: number): string => `direct:\n  host: 127.0.0.1\n  port: ${String(port)}\n`;

async function homeWith(disk: string | undefined, accepted: string | undefined): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'fy-home-port-fallback-'));
  homes.push(home);
  if (disk !== undefined) {
    await mkdir(join(home, 'config'), { recursive: true });
    await writeFile(join(home, 'config/connections.yaml'), disk);
  }
  if (accepted !== undefined) {
    await mkdir(join(home, 'state/kernel/accepted-config'), { recursive: true });
    await writeFile(
      join(home, 'state/kernel/accepted-config/connections.yaml.json'),
      JSON.stringify({ format: 1, etag: 'e', text: accepted, plugin: 'connections' }),
    );
  }
  return home;
}

describe('the port fy dials before any run record exists', () => {
  test('is the accepted port while a different port is held on disk', async () => {
    expect(await readHomePort(await homeWith(text(43_211), text(43_210)))).toBe(43_210);
  });
  test('is nothing when the file on disk was never accepted (a held first edit)', async () => {
    expect(await readHomePort(await homeWith(text(43_211), undefined))).toBeUndefined();
  });
  test('is nothing for a home with no files', async () => {
    expect(await readHomePort(await homeWith(undefined, undefined))).toBeUndefined();
  });
});
