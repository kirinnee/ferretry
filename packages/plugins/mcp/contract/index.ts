/**
 * @ferretry/plugin-mcp/contract — wire schemas, port + token, events, state and config declarations, words, audit kinds.
 * MCP owns the `mcp` item kind (§4.9): servers as inert data, their sign-ins (tokens sealed in the Vault, by name) and
 * the inventory of every server a ferret sees. It takes `launch.parts` and offers nothing but a read port.
 */
import type { Word } from '@ferretry/kernel/contract';
import { defineConfig, defineEvent, definePort, defineState, neverLoosens } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { configDef } from './config-def.ts';
import {
  type McpCheckResult,
  type McpInventory,
  type McpOAuthConnection,
  McpInventoryFileSchema,
  McpItemSchema,
} from './wire.ts';

export * from './wire.ts';

export const MCP = 'mcp' as const;

export const MCP_WORDS: readonly Word[] = [{ word: 'MCP server', means: 'a program that gives a ferret more tools' }];

// ─── port ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What others and the app may read. The servers themselves reach a ferret through Ferrets' `launch.parts` hook. */
export interface McpApi {
  /** Every server one ferret sees (with `ferret`), or the whole machine. */
  inventory(ferret?: string): Promise<McpInventory>;
  /** Connect to one server from an inventory and list its tools. Can start a command, so it is governed as running one. */
  check(id: string, ferret?: string): Promise<McpCheckResult>;
  /** Where each sign-in stands. Never a token, only names and expiries. */
  connections(): Promise<readonly McpOAuthConnection[]>;
}
export const McpPort = definePort<McpApi>('mcp');

/** Read models others may call (`manifest.data.readModels`). */
export const MCP_READ_MODELS = ['inventory', 'check', 'connections'] as const;

// ─── events ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A sign-in was finished, ended or removed (after its write). The component name only. */
export const McpSignInChanged = defineEvent(
  'mcp.sign-in-changed',
  z.strictObject({ component: z.string().min(1).max(256) }),
);

/** A server was added for a ferret (project file or login). The server's NAME only, never its command or environment (G179). */
export const McpServerAdded = defineEvent(
  'mcp.server-added',
  z.strictObject({ name: z.string().min(1), scope: z.enum(['project', 'login']) }),
);

// ─── state (§9.2) ────────────────────────────────────────────────────────────────────────────────────────────────

export const MCP_INVENTORY_STATE = defineState({
  name: 'inventory',
  path: 'inventory.json',
  store: 'json',
  format: 1,
  schema: McpInventoryFileSchema,
});

/** Pinned payloads (§4.9): a package with its integrity hash, fetched once and run from here. Opaque to the kernel. */
export const MCP_PAYLOADS_STATE = defineState({ name: 'payloads', path: 'payloads/*', store: 'opaque', format: 1 });

// ─── config (§9.2, §7.2) ─────────────────────────────────────────────────────────────────────────────────────────

const ITEM_NAME = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/**
 * `config/mcp/<name>.yaml`. Today a component edit changes what an agent RUNS WITH, which every editor may already
 * change, not what it may spend or control (`configLoosening`: "any other edit to a … component … loosens nothing").
 */
export const MCP_CONFIG = configDef(
  defineConfig({
    collection: 'mcp',
    name: ITEM_NAME,
    schema: McpItemSchema,
    axis: 'configure',
    loosens: neverLoosens,
  }),
);

// ─── audit kinds (Gate's log; today's `fleet.configured` with `action`/`scope` detail) ──────────────────────────────

/** Names and flow ids only, never an address or a token. */
export const MCP_AUDIT = {
  signIn: 'fleet.configured:mcp-sign-in',
  signInFinish: 'fleet.configured:mcp-sign-in-finish',
  signInCancel: 'fleet.configured:mcp-sign-in-cancel',
  signOut: 'fleet.configured:mcp-sign-out',
  /** `scope: 'project'`: the repo's `.mcp.json`. The session and the server's NAME, never its command, address or environment (G179). */
  addProject: 'fleet.configured:mcp-add-project',
  /** `scope: 'login'`: a component appended to the runtime's profile. */
  addLogin: 'fleet.configured:mcp-add-login',
} as const;
