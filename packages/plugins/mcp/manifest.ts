import { definePlugin, panel, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import { audit, cap } from '@ferretry/core-gate/contract';
import { FerretsPort, LaunchParts } from '@ferretry/core-ferrets/contract';
import { VaultPort } from '@ferretry/core-vault/contract';
import {
  MCP_AUDIT,
  MCP_CONFIG,
  MCP_INVENTORY_STATE,
  MCP_OAUTH_STATE,
  MCP_PAYLOADS_STATE,
  MCP_READ_MODELS,
  MCP_WORDS,
  McpPort,
  McpServerAdded,
  McpSignInChanged,
} from './contract/index.ts';

/**
 * MCP (§2.3): MCP servers as items. Routes are today's mounts (`mcp-inventory.ts`, `mcp-oauth.ts`, `session-mcp.ts`),
 * descriptor fields copied exactly. Paths follow §3.2/§1.4: `/v1/fleet/mcp-auth…` → `/v1/mcp/auth…`;
 * `/v1/sessions/:sessionId/…` → `/v1/ferrets/:ferretId/…`.
 *
 * GAPS (for the port / the lead): `permissions.spawn` and `permissions.network` cannot be enumerated here. A check starts
 * the owner's own stdio command (any program) and a remote server or its authorization server is any host the owner
 * names; today's code spawns and fetches freely. The kernel ports refuse what is undeclared, so the port needs a
 * decision on a data-driven allowance before `ports-pending` can drop `mcp`.
 */
export default definePlugin({
  id: 'mcp',
  title: 'MCP',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['item', 'command', 'view'],
  words: MCP_WORDS,

  needs: { ferrets: FerretsPort, vault: VaultPort },

  provides: { mcp: McpPort },

  actions: {
    routes: [
      // ── inventory and check (docs/mcp-scopes.md) ────────────────────────────────────────────────────────────────
      route('GET /v1/mcp', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read; the inventory is not recorded today' },
        guard: { none: 'addresses without their query, programs without arguments; no pane text, no secret' },
      }),
      route('POST /v1/mcp/check', {
        minimum: 'operator',
        caller: 'any',
        // A check can START A COMMAND (a stdio server), so it is governed as running one.
        capability: cap('terminal', 'use'),
        noStore: true,
        audit: { skip: 'not recorded today (no rule in lib/audit/routes.ts)' },
        guard: { none: 'tool names and a sentence that quotes no token' },
      }),
      route('GET /v1/ferrets/:ferretId/mcp/servers', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('filesystem', 'use'),
        noStore: true,
        audit: { skip: 'a read; the inventory is not recorded today' },
        guard: { none: 'addresses without their query, programs without arguments; no pane text, no secret' },
      }),

      // ── sign-in (docs/mcp-oauth.md): fleet.configure for every act, fleet.use for the read ───────────────────────
      route('GET /v1/mcp/auth', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'a read; it says THAT a server is signed in and until when, never with what' },
        guard: { none: 'secret names and expiries, never a token (S174)' },
      }),
      route('POST /v1/mcp/auth/:component', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(MCP_AUDIT.signIn),
        guard: { none: 'an authorization URL anybody may open; no token' },
      }),
      route('DELETE /v1/mcp/auth/:component', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(MCP_AUDIT.signOut),
        guard: { none: 'whether it was removed and revoked, no token' },
      }),
      route('POST /v1/mcp/auth/flows/:flowId', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(MCP_AUDIT.signInFinish),
        guard: {
          none: 'the connection facts; the callback address (a code) is accepted in the body and never repeated',
        },
      }),
      route('DELETE /v1/mcp/auth/flows/:flowId', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(MCP_AUDIT.signInCancel),
        guard: { none: 'a flow id and whether it was cancelled' },
      }),

      // ── adding a server for one ferret: ONE ROUTE PER SCOPE, exactly one capability each (G176) ──────────────────
      // Registered deeper paths first in today's table; the router here sorts by specificity.
      route('POST /v1/ferrets/:ferretId/mcp/project/preview', {
        minimum: 'operator',
        caller: 'any',
        // A read with a body: it reads the file and writes nothing.
        capability: cap('filesystem', 'use'),
        noStore: true,
        audit: { skip: 'previews write nothing and are not logged (G179)' },
        guard: { none: 'a diff of the project file; no secret value crosses (G180)' },
      }),
      route('POST /v1/ferrets/:ferretId/mcp/login/preview', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'previews write nothing and are not logged (G179)' },
        guard: { none: 'a runtime, a profile and a count; no secret value crosses (G180)' },
      }),
      route('POST /v1/ferrets/:ferretId/mcp/project', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('filesystem', 'configure'),
        noStore: true,
        audit: audit(MCP_AUDIT.addProject),
        guard: { none: 'the added name, path and etag' },
      }),
      route('POST /v1/ferrets/:ferretId/mcp/login', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: audit(MCP_AUDIT.addLogin),
        guard: { none: 'the added name, runtime and profile' },
      }),
      route('GET /v1/ferrets/:ferretId/mcp', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('filesystem', 'use'),
        noStore: true,
        audit: { skip: 'a read of the project file listing' },
        guard: { none: 'server names and transports of the project file' },
      }),
    ],
    cli: [
      verb('mcp serve', {
        summary: 'serve the terminal and browser tools over MCP on stdin/stdout, as this agent session',
      }),
      verb('mcp ls', { summary: 'list the MCP servers a ferret sees, by scope, with approval and sign-in' }),
      verb('mcp check', { summary: 'connect to one MCP server and list its tools, by name or id' }),
      verb('mcp add', { summary: 'add an MCP server item' }),
      verb('mcp show', { summary: 'one MCP server item and where it is used' }),
      verb('mcp edit', { summary: 'change an MCP server item; every profile and runtime that uses it changes too' }),
      verb('mcp rm', { summary: 'remove an MCP server item' }),
    ],
  },

  ui: {
    // Info › Folder › MCP and the Tools row of a ferret (docs/mcp-scopes.md).
    panels: [panel('ferret.side', { id: 'mcp-servers', order: 40 })],
    settings: [settingsTab('mcp', { label: 'MCP servers', order: 50 })],
  },

  data: {
    state: [MCP_INVENTORY_STATE, MCP_OAUTH_STATE, MCP_PAYLOADS_STATE],
    config: [MCP_CONFIG],
    readModels: MCP_READ_MODELS,
    publishes: [McpSignInChanged, McpServerAdded],
  },

  hooks: {
    takes: [{ hook: LaunchParts }],
  },

  doctor: ['mcp-inventory'],

  permissions: {
    roots: ['work'],
    // GAP: see the note above. Declared empty rather than guessed.
    network: [],
    spawn: [],
    secrets: [],
  },
});
