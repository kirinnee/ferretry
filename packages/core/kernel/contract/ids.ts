import { type Brand, KEBAB_NAME } from '@ferretry/std';
import { z } from 'zod';

/** A subsystem id: kebab-case, unique; also its state folder, log scope, route prefix and CLI noun (§3.2). */
export type PluginId = Brand<string, 'PluginId'>;
export const PluginIdSchema = z
  .string()
  .regex(KEBAB_NAME)
  .max(40)
  .transform(value => value as PluginId);

/** The five core pieces (§2.2). Only these may provide a kernel-bound port or offer a security-path decide hook. */
export const CORE_IDS = ['kernel', 'gate', 'asks', 'vault', 'ferrets'] as const;
export type CoreId = (typeof CORE_IDS)[number];

/**
 * The kinds of item a plugin's items can be (`permissions.spawn: [{ items: 'mcp' }]`, a config collection's
 * `itemKind`). Here because a contract names it (`defineConfig`); the manifest re-exports it.
 */
export type ItemKind =
  | 'mcp'
  | 'skill'
  | 'shell'
  | 'recipe'
  | 'instruction'
  | 'layout'
  | 'theme'
  | 'runtime'
  | 'endpoint';

/** The plugin API major this kernel accepts; exactly one (§3.2, §9). */
export const PLUGIN_API = 5 as const;
export type PluginApi = typeof PLUGIN_API;

/** A ferret's id, minted by Ferrets. The kernel only carries it (spawn limits, work folders, actor stamps). */
export type FerretId = Brand<string, 'FerretId'>;

/**
 * The device id or member key id whose key signed a session's transcript (§7.1).
 * A Catalogs member session names the member KEY id (today's SessionMember.keyId),
 * so tracking, unlocking and revoking apply to that key individually.
 */
export type HolderId = Brand<string, 'HolderId'>;

/** One sealed session on the session layer. */
export type SessionId = Brand<string, 'SessionId'>;

/** A carrier key under the kernel's `carriers` hook: `direct`, `relay`, `tunnel`, `webrtc`. */
export type CarrierKey = Brand<string, 'CarrierKey'>;
