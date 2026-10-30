/**
 * Where a daemon's port comes from in a fixture: the operating system, through the daemon itself.
 *
 * A fixture writes `port: OS_CHOSEN_PORT` into the document and the daemon binds port 0 and records what
 * the kernel gave it. A number found "free" by one process and handed to another is a number somebody
 * else may take in between, which is the race this replaces.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { declaredBind } from '@ferretry/protocol';
import { OS_CHOSEN_PORT } from '../../../src/lib/runtime/carriers.ts';

export { OS_CHOSEN_PORT };

const SAFETY_NET_MS = 60_000;
const POLL_MS = 20;

/** The recorded bind port in a `config/daemon.json` body, or `undefined` while it is still `0` or absent. */
function recordedIn(text: string): number | undefined {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof document !== 'object' || document === null) return undefined;
  const { port } = declaredBind(document) as { readonly port?: unknown };
  return typeof port === 'number' && Number.isInteger(port) && port > OS_CHOSEN_PORT ? port : undefined;
}

/**
 * The port the daemon in this state home was given, once it has bound and written it down.
 *
 * The condition is the daemon's own record, and the timeout is only a safety net: a daemon that refused
 * to boot never records one, and a test waiting on it should fail with that said rather than hang.
 */
export async function recordedPort(home: string, timeoutMs: number = SAFETY_NET_MS): Promise<number> {
  const file = join(home, 'config', 'daemon.json');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await readFile(file, 'utf8').catch(() => undefined);
    const port = text === undefined ? undefined : recordedIn(text);
    if (port !== undefined) return port;
    if (Date.now() >= deadline) throw new Error(`the daemon never recorded the port it bound in ${file}`);
    await Bun.sleep(POLL_MS);
  }
}
