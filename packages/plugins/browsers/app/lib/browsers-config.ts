/**
 * `browsers.yaml` THROUGH THE KERNEL'S CONFIG FILE SERVICE (docs/config-files.md): the browser's mode and proxy are
 * read and written as the one document they live in, against the digest they were read at.
 *
 * ASSUMED, NOT DECLARED HERE: the service's routes keep today's keys — `GET /v1/config/file?path=` and
 * `PUT /v1/config/file` — and the client reaches them by key like any route. While no compiled manifest declares them
 * the shell's client refuses the call before sending, and the tab says so; this is the ONE file to change when the
 * kernel declares its routes. Credentials are only ever `${secret:NAME}` references: the schema refuses a value.
 */

import { parse, parseDocument } from 'yaml';
import { z } from 'zod';
import {
  type BrowserMode,
  type BrowserProxySetting,
  BrowsersConfigSchema,
  type BrowsersConfig,
} from '../../contract/index.ts';
import type { CallClient } from './clients.ts';

export const BROWSERS_FILE = 'browsers.yaml';

const NonEmpty = z.string().min(1);

/** One file as it is on disk, with its digest to edit against. */
const ConfigFileViewSchema = z.looseObject({ path: NonEmpty, exists: z.boolean(), text: z.string(), etag: NonEmpty });

const ConfigPutResultSchema = z.looseObject({
  path: NonEmpty,
  etag: NonEmpty,
  outcome: z.enum(['applied', 'pending']),
});

export interface BrowsersDocument {
  readonly config: BrowsersConfig;
  readonly text: string;
  readonly etag: string;
}

/** The saved browser settings and the digest they were read at. A file that does not parse is not guessed at. */
export async function readBrowsersConfig(client: CallClient): Promise<BrowsersDocument> {
  const file = ConfigFileViewSchema.parse(await client.call('GET /v1/config/file', { query: { path: BROWSERS_FILE } }));
  const parsed: unknown = file.text.trim() === '' ? {} : parse(file.text);
  return { config: BrowsersConfigSchema.parse(parsed ?? {}), text: file.text, etag: file.etag };
}

export interface BrowsersChange {
  readonly mode?: BrowserMode;
  /** `null` turns the proxy off. */
  readonly proxy?: BrowserProxySetting | null;
}

/** The document with the change made, comments and order kept. Pure. */
export function editedBrowsersText(text: string, change: BrowsersChange): string {
  const document = parseDocument(text);
  if (change.mode !== undefined) document.set('mode', change.mode);
  if (change.proxy === null) document.delete('proxy');
  else if (change.proxy !== undefined) document.set('proxy', change.proxy);
  return String(document);
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
