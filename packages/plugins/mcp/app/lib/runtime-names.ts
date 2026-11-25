/**
 * The plain-words name of each runtime on this machine, for "Seen by". A server's inventory names the runtimes that see it
 * by their STORED name (`claude-default`, `codex-you`), which means nothing to a person, so the details line asks
 * Runtimes' catalog (`GET /v1/runtimes`) and says each one the way every
 * other screen does (`runtimeDisplayName`). Missing evidence stays missing: a read that fails, or a runtime that is not
 * in the answer, is named by its tool ("Claude runtime"), never by its stored name.
 */
import { useEffect, useState } from 'react';
import {
  RuntimeCatalogSchema,
  harnessWord,
  runtimeAccountsFrom,
  runtimeDisplayName,
} from '@ferretry/plugin-runtimes/contract';
import type { McpInventoryServer } from '../../contract/index.ts';
import type { McpClient } from './client.ts';

/** Stored runtime name → its words. */
export type RuntimeNames = ReadonlyMap<string, string>;

const NONE: RuntimeNames = new Map();

/** Every runtime's words, by stored name; empty when Runtimes cannot be read (it may be off on this machine). */
const readRuntimeNames = async (client: McpClient): Promise<RuntimeNames> => {
  try {
    const runtimes = RuntimeCatalogSchema.parse(await client.call<unknown>('GET /v1/runtimes')).runtimes;
    // Two runtimes that would read alike are told apart by ACCOUNT (Logins' list, read here as a plain route), then profile.
    // Logins that cannot be read tell nobody apart: the profile words still do, and a stored name is the last resort.
    const accounts = await client
      .call<unknown>('GET /v1/logins')
      .then(runtimeAccountsFrom, () => runtimeAccountsFrom(null));
    return new Map(runtimes.map(runtime => [runtime.name, runtimeDisplayName(runtime, runtimes, accounts)] as const));
  } catch {
    return NONE;
  }
};

/** The runtime names, read once when `enabled` first holds (a view that shows them only on demand asks for them then). */
export const useRuntimeNames = (client: McpClient, enabled = true): RuntimeNames => {
  const [names, setNames] = useState<RuntimeNames>(NONE);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    void readRuntimeNames(client).then(read => {
      if (live) setNames(read);
    });
    return () => {
      live = false;
    };
  }, [client, enabled]);
  return names;
};

/** One runtime that sees a server, in words: its own name when known, else its tool. */
export const seenByName = (names: RuntimeNames, stored: string, harness: McpInventoryServer['harness']): string =>
  names.get(stored) ?? `${harnessWord(harness)} runtime`;
