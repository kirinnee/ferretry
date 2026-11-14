import { definePlugin, panel, route, settingsTab, verb } from '@ferretry/kernel/manifest';
import { audit, cap } from '@ferretry/core-gate/contract';
import { ACTIONS_ROW_SLOT, FerretsPort, LaunchParts } from '@ferretry/core-ferrets/contract';
import { SealedDocumentsPort, VaultPort } from '@ferretry/core-vault/contract';
import { ClaudeCodePort } from '@ferretry/plugin-claude-code/contract';
import { ProjectsPort } from '@ferretry/plugin-projects/contract';
import { PROFILE_COMPONENTS_KEY, ProfileMcpSource, RuntimesPort } from '@ferretry/plugin-runtimes/contract';
import {
  MCP_AUDIT,
  MCP_CONFIG,
  MCP_INVENTORY_STATE,
  MCP_OAUTH_SECRETS,
  MCP_OAUTH_STATE,
  MCP_PAYLOADS_STATE,
  MCP_READ_MODELS,
  MCP_WORDS,
  McpPort,
  McpServerAdded,
  McpSignInChanged,
  SIGN_IN_SECRET_NAME,
} from './contract/index.ts';

/**
 * MCP (§2.3): MCP servers as items. Routes are today's mounts (`mcp-inventory.ts`, `mcp-oauth.ts`, `session-mcp.ts`),
 * descriptor fields copied exactly. Paths follow §3.2/§1.4: `/v1/fleet/mcp-auth…` → `/v1/mcp/auth…`;
 * `/v1/sessions/:sessionId/…` → `/v1/ferrets/:ferretId/…`.
 *
 * A check starts the owner's own stdio command: `permissions.spawn` is the data-driven `mcp-commands` resolver (the
 * configured servers' commands and the one a check is starting, nothing else). GAP (for the port / the lead): a check's
 * own network reach is still undeclared (it reaches the server it checks; today's code fetches freely), so `ports-pending`
 * cannot drop `mcp` yet. The sign-in's reach is declared (`network`, the `mcp-sign-in` resolver).
 */
export default definePlugin({
  id: 'mcp',
  title: 'MCP',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['item', 'command', 'view'],
  words: MCP_WORDS,

  // `sealed`: the sign-in's own refresh tokens and client secrets (MCP_OAUTH_SECRETS), never another plugin's.
  needs: { ferrets: FerretsPort, vault: VaultPort, sealed: SealedDocumentsPort },

  // Optional (lead ruling): Claude Code answers which project servers it approved for a ferret, read from its OWN
  // home (MCP has no root there); Projects answers the registered roots a launch folder belongs to. Off = fail closed
  // (no project server bound) and each folder its own project. Codex is not asked: its answer is always `not-taken`
  // (today handed a Codex launch nothing), so MCP answers that itself, whether or not Codex's daemon half is built.
  // Runtimes answers the published accounts (a runtime's home, read through its bounded reader), the profile layers
  // that say which items a runtime carries, a launch's runtime, and a login add's runtime and profile (it also takes
  // the one `mcp/<name>` layer). Off = no accounts and no item on any launch. None of the three uses MCP, so the graph
  // stays acyclic.
  uses: { claudeCode: ClaudeCodePort, projects: ProjectsPort, runtimes: RuntimesPort },

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
        args: [],
      }),
      verb('mcp ls', {
        summary: 'list the MCP servers a ferret sees, by scope, with approval and sign-in',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('mcp check', {
        summary: 'connect to one MCP server and list its tools, by name or id',
        args: [{ name: 'server', help: 'the MCP server to check; every one it can see when left out' }],
        options: [
          {
            flag: '--session <id>',
            help: 'check it as this ferret reaches it (default: this one, when run inside one)',
          },
          { flag: '--machine', help: 'pick the server from the whole machine instead of one ferret' },
          {
            flag: '--scope <scope>',
            help: 'when the name is declared twice: ferretry, component, user, project or local',
          },
          { flag: '--json', help: 'print the protocol result' },
        ],
      }),
      verb('mcp add', {
        summary: 'add an MCP server item',
        args: [{ name: 'name', help: 'the MCP server item’s name' }],
        options: [
          { flag: '--command <command>', help: 'MCP: the command to run' },
          { flag: '--arg <arg>', help: 'MCP: one argument; repeat it' },
          { flag: '--url <url>', help: 'MCP: the server address, instead of a command' },
          { flag: '--env <NAME=value>', help: 'MCP or settings: one environment variable; repeat it' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
      verb('mcp show', {
        summary: 'one MCP server item and where it is used',
        args: [{ name: 'name', help: 'the MCP server item’s name' }],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('mcp edit', {
        summary: 'change an MCP server item; every profile and runtime that uses it changes too',
        args: [{ name: 'name', help: 'the MCP server item’s name' }],
        options: [
          { flag: '--command <command>', help: 'MCP: the command to run' },
          { flag: '--arg <arg>', help: 'MCP: one argument; repeat it' },
          { flag: '--url <url>', help: 'MCP: the server address, instead of a command' },
          { flag: '--env <NAME=value>', help: 'MCP or settings: one environment variable; repeat it' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
      verb('mcp rm', {
        summary: 'remove an MCP server item',
        args: [{ name: 'name', help: 'the MCP server item’s name' }],
        options: [
          { flag: '--remove-from-profiles', help: 'take it out of every profile that has it first' },
          { flag: '--dry-run', help: 'show what would change, and change nothing' },
          { flag: '-y, --yes', help: 'go ahead without asking' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
    ],
  },

  ui: {
    // Info › Folder › MCP and the Tools row of a ferret (docs/mcp-scopes.md).
    panels: [
      panel('ferret.side', { id: 'mcp-servers', order: 40 }),
      // Ferrets' Actions ▾ menu: MCP's own row, "Add MCP server…".
      panel(ACTIONS_ROW_SLOT, { id: 'add-mcp-row', order: 10 }),
    ],
    settings: [settingsTab('mcp', { label: 'MCP servers', order: 50 })],
  },

  /** Never reached by a ferret, through any root: the sealed OAuth refresh tokens and client secrets (`PrivacyDecl`). */
  privacy: {
    private: ['oauth-secrets.json'],
    public: [
      {
        path: 'oauth.json',
        reason:
          'Sign-in facts that are not secret: issuer, endpoints, client id and expiry, never a token; the refresh tokens are sealed in oauth-secrets.json.',
      },
    ],
  },
  data: {
    state: [MCP_INVENTORY_STATE, MCP_OAUTH_STATE, MCP_OAUTH_SECRETS.state, MCP_PAYLOADS_STATE],
    config: [MCP_CONFIG],
    readModels: MCP_READ_MODELS,
    publishes: [McpSignInChanged, McpServerAdded],
  },

  hooks: {
    // Runtimes reads the `mcp` components a profile names through this plugin, which alone owns them (its `takers` list).
    takes: [{ hook: LaunchParts }, { hook: ProfileMcpSource, key: PROFILE_COMPONENTS_KEY }],
  },

  doctor: ['mcp-inventory'],

  permissions: {
    // `work`: a ferret's own folder. `imports`: ONLY the `.mcp.json` of a registered project root or a live managed
    // worktree, read-only (lead ruling (B); `daemon/adapters/project-root-files.ts`).
    roots: ['work', 'imports'],
    // Sign-in: the servers being signed in to, and the issuer and endpoints their metadata named, answered by the
    // `mcp-sign-in` resolver (`daemon/lib/reach.ts`). The check's own reach is still the GAP above.
    network: [{ resolver: 'mcp-sign-in' }],
    // The programs of the owner's own configured servers, and the one a check is starting (`mcp-commands`,
    // `daemon/lib/allowed-commands.ts`): data, never a wildcard.
    spawn: [{ resolver: 'mcp-commands' }],
    secrets: [],
    // The OAuth access tokens a sign-in files in the Vault (`mcpOAuthSecretNames`): today's exact names, and no others.
    mintedSecrets: [SIGN_IN_SECRET_NAME],
  },
});
