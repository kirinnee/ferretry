/**
 * `browsers.yaml` THROUGH THE KERNEL'S CONFIG FILE SERVICE (docs/config-files.md): the browser's mode and proxy are
 * read and written as the one document they live in, against the digest they were read at.
 *
 * The routes are the KERNEL's (D2 #3): `GET /v1/config/file?path=` and `PUT /v1/config/file`, declared by
 * `@ferretry/kernel/plugin` and reached by key like any route. No plugin declares them; the kernel resolves the path
 * to the file this plugin declares (`browsers.yaml`) and Gate answers who may read or write it. The shell client
 * carries no headers, so the etag travels in the body. Credentials are only ever `${secret:NAME}` references: the
 * schema refuses a value.
 */

import { readConfigText, setConfigKey } from '@ferretry/std/yaml';
import { z } from 'zod';
import {
  type BrowserMode,
  type BrowserProxySetting,
  type StealthSwitch,
  BrowsersConfigSchema,
  type BrowsersConfig,
} from '../../contract/index.ts';
import { STEALTH_LOOSENING } from '../../contract/config-loosens.ts';
import type { CallClient } from './clients.ts';

const BROWSERS_FILE = 'browsers.yaml';

const NonEmpty = z.string().min(1);

/** One file as it is on disk, with its digest to edit against. */
const ConfigFileViewSchema = z.looseObject({
  path: NonEmpty,
  exists: z.boolean(),
  text: z.string(),
  etag: NonEmpty,
  /** `pending`: the file on disk holds an edit the owner has not confirmed, so it is not what is in effect. */
  state: z.enum(['ok', 'pending', 'invalid']).optional(),
});

const ConfigPutResultSchema = z.looseObject({
  path: NonEmpty,
  etag: NonEmpty,
  outcome: z.enum(['applied', 'pending']),
});

export interface BrowsersDocument {
  readonly config: BrowsersConfig;
  readonly text: string;
  readonly etag: string;
  /** The disk text waits for the owner's confirmation (the kernel's `pending`), so it is not yet what is in effect. */
  readonly held: boolean;
  /**
   * What waits is the machine-wide stealth `on` itself, so the switch in effect is still off. A file held for another
   * key (the proxy) while stealth is already on in effect is `held` but NOT this: the switch reads on.
   */
  readonly stealthHeld: boolean;
}

const PendingStatusSchema = z.looseObject({
  pending: z.array(z.looseObject({ path: NonEmpty, changes: z.array(z.string()) })),
});

/** Whether the daemon holds the stealth `on` for the owner, from what it says is waiting (an unreadable answer counts as held: off is the safe reading). */
async function stealthWaits(client: CallClient): Promise<boolean> {
  try {
    const status = PendingStatusSchema.parse(await client.call('GET /v1/config/status', {}));
    return status.pending.some(held => held.path === BROWSERS_FILE && held.changes.includes(STEALTH_LOOSENING));
  } catch {
    return true;
  }
}

/** The saved browser settings and the digest they were read at. A file that does not parse is not guessed at. */
export async function readBrowsersConfig(client: CallClient): Promise<BrowsersDocument> {
  const file = ConfigFileViewSchema.parse(await client.call('GET /v1/config/file', { query: { path: BROWSERS_FILE } }));
  const read = readConfigText(file.text);
  if (!read.ok)
    throw new Error(`browsers.yaml cannot be read: ${read.errors[0]?.message ?? 'the text cannot be read as YAML'}`);
  const config = BrowsersConfigSchema.parse(read.read.value ?? {});
  const held = file.state === 'pending';
  return {
    config,
    text: file.text,
    etag: file.etag,
    held,
    stealthHeld: held && config.stealth === 'on' && (await stealthWaits(client)),
  };
}

export interface BrowsersChange {
  readonly mode?: BrowserMode;
  /** The one stealth switch; `on` waits for the owner (browsers.yaml loosens). */
  readonly stealth?: StealthSwitch;
  /** `null` turns the proxy off. */
  readonly proxy?: BrowserProxySetting | null;
}

/** The document with the change made, comments and order kept. Pure. */
function editedBrowsersText(text: string, change: BrowsersChange): string {
  const withMode = change.mode === undefined ? text : setConfigKey(text, 'mode', change.mode);
  const withStealth = change.stealth === undefined ? withMode : setConfigKey(withMode, 'stealth', change.stealth);
  if (change.proxy === undefined) return withStealth;
  return setConfigKey(withStealth, 'proxy', change.proxy === null ? undefined : change.proxy);
}

/** Writes the change against the digest it was read at; the daemon refuses a file changed since. */
export async function writeBrowsersConfig(
  client: CallClient,
  current: BrowsersDocument,
  change: BrowsersChange,
): Promise<'applied' | 'pending'> {
  const result = ConfigPutResultSchema.parse(
    await client.call('PUT /v1/config/file', {
      body: { path: BROWSERS_FILE, text: editedBrowsersText(current.text, change), etag: current.etag },
    }),
  );
  return result.outcome;
}
