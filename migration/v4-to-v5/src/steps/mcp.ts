/**
 * MCP: v4's non-secret sign-in state → `state/mcp/oauth.json` (`packages/plugins/mcp/contract`: `inventory.json`,
 * `oauth.json`, `payloads/*`). Lead decision M5: `mcp-oauth.json` belongs to MCP.
 *
 * - `state/mcp-oauth.json` `{v: 1, registrations, connections}` → `oauth.json` `{format: 1, registrations, connections}`.
 *   v5's record schemas are v4's field for field (`contract/oauth-state.ts` vs v4 `file-state-store.ts`), and
 *   `clientSecretRef` names a secret with the same grammar in both, so only the envelope changes. Component names
 *   (the record keys) are kept, since `config/mcp/<name>.yaml` and the vault names join on them.
 * - The ACCESS tokens are vault secrets kept by NAME; the Vault step moves the vault unopened, so the names travel.
 * - `state/mcp-oauth-secrets.json` (refresh tokens, registered client secrets; sealed under the vault key) is NOT
 *   carried and NOT opened: v5 MCP declares no `store: 'secret'` document for it yet (`data.state` is inventory, oauth
 *   and payloads only; the Vault's `defineSealedDocument` has no MCP declaration). It stays in the kept v4 backup, so
 *   it can be moved byte for byte once MCP declares that file.
 * - `inventory.json` and `payloads/` have no v4 source: v4 computed the inventory live and pinned no payloads.
 */
import { MCP_OAUTH_STATE, McpOAuthStateFileSchema } from '@ferretry/plugin-mcp/contract';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { StepReport } from '../report.ts';
import { failureNote, readV4Json, V4InputError } from '../v4/documents.ts';
import { V4_MCP_OAUTH, V4_MCP_OAUTH_SECRETS, V4McpOAuthDocument } from '../v4/mcp.ts';
import type { Step } from './index.ts';

export const V5_MCP_OAUTH = join('state/mcp', MCP_OAUTH_STATE.path);

export const mcpStep: Step = {
  id: 'mcp',
  title: 'MCP sign-ins (issuer, endpoints, client ids, expiry; tokens stay in the vault by name)',
  owner: ['plugin-mcp'],
  reads: [V4_MCP_OAUTH],
  sealed: [],
  notCarried: [
    {
      what: `${V4_MCP_OAUTH_SECRETS} (sealed: MCP refresh tokens and registered client secrets)`,
      why: 'v5 MCP declares no store: secret document to move it into (its state is inventory.json, oauth.json and payloads/ only), so it is left unopened in the v4 backup. Until MCP declares it, an OAuth MCP server whose access token expires must be signed in to again from the app',
    },
    {
      what: 'the MCP inventory',
      why: 'v4 kept none (computed live); v5 writes inventory.json itself on its first read',
    },
    {
      what: 'config/components/mcp/*.yaml (the servers themselves)',
      why: 'configuration, not state: the Layouts and settings step carries them to config/mcp/<name>.yaml',
    },
  ],
  async run(ctx): Promise<StepReport> {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried, sealed: [] };
    const home = ctx.v4.home;
    try {
      const notes: string[] = ctx.dryRun ? ['dry run: nothing written'] : [];
      // `lstat` only: the sealed half is never opened, its presence is all the report says.
      if ((await lstat(join(home, V4_MCP_OAUTH_SECRETS)).catch(() => undefined)) !== undefined)
        notes.push(`${V4_MCP_OAUTH_SECRETS} left unopened in the v4 backup (no v5 file declared for it yet)`);

      const value = await readV4Json(home, join(home, V4_MCP_OAUTH));
      if (value === undefined)
        return {
          ...base,
          status: 'converted',
          note: ['this home has no MCP sign-ins', ...notes].join('; '),
          kept: [],
        };
      const v4 = V4McpOAuthDocument.safeParse(value);
      if (!v4.success) throw new V4InputError(`${V4_MCP_OAUTH}: is not a v4 MCP sign-in document (v: 1)`);
      const document = McpOAuthStateFileSchema.safeParse({
        format: MCP_OAUTH_STATE.format,
        registrations: v4.data.registrations,
        connections: v4.data.connections,
      });
      if (!document.success) {
        const [section, name] = document.error.issues[0]?.path ?? [];
        throw new V4InputError(
          `${V4_MCP_OAUTH}: ${String(section)} of component ${JSON.stringify(String(name))} does not fit the v5 record`,
        );
      }
      await ctx.v5.json(
        { path: V5_MCP_OAUTH, format: MCP_OAUTH_STATE.format, schema: McpOAuthStateFileSchema },
        document.data,
      );
      const registrations = Object.values(document.data.registrations).reduce((sum, list) => sum + list.length, 0);
      return {
        ...base,
        status: 'converted',
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
        kept: [
          { what: 'MCP sign-ins (connections)', count: Object.keys(document.data.connections).length },
          { what: 'MCP client registrations', count: registrations },
        ],
      };
    } catch (error) {
      return { ...base, status: 'failed', note: failureNote(error, 'cannot convert the MCP sign-in state'), kept: [] };
    }
  },
};
