/**
 * MCP: v4's non-secret sign-in state → `state/mcp/oauth.json` (`packages/plugins/mcp/contract`: `inventory.json`,
 * `oauth.json`, `payloads/*`). Lead decision M5: `mcp-oauth.json` belongs to MCP.
 *
 * - `state/mcp-oauth.json` `{v: 1, registrations, connections}` → `oauth.json` `{format: 1, registrations, connections}`.
 *   v5's record schemas are v4's field for field (`contract/oauth-state.ts` vs v4 `file-state-store.ts`), and
 *   `clientSecretRef` names a secret with the same grammar in both, so only the envelope changes. Component names
 *   (the record keys) are kept, since `config/mcp/<name>.yaml` and the vault names join on them.
 * - The ACCESS tokens are vault secrets kept by NAME; the Vault step moves the vault unopened, so the names travel.
 * - `state/mcp-oauth-secrets.json` (refresh tokens, registered client secrets) → `state/mcp/oauth-secrets.json` (lead
 *   decision 2026-11-07, via nelly: MCP's `defineSealedDocument`). It is sealed under the VAULT key with the entry name as
 *   the AAD (Vault contract `sealed.ts`), so the Vault step's key move (`state/vault/vault.key`, done once, before
 *   this step) opens it. Every entry's `iv`, `ciphertext` and stamps move as the same strings; only the envelope's
 *   `v: 1` becomes `format: 1`, which is outside the AAD. Nothing is decrypted or printed.
 * - `inventory.json` and `payloads/` have no v4 source: v4 computed the inventory live and pinned no payloads.
 */
import { SealedDocumentSchema } from '@ferretry/core-vault/contract';
import { MCP_OAUTH_SECRETS, MCP_OAUTH_STATE, McpOAuthStateFileSchema } from '@ferretry/plugin-mcp/contract';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { StepReport } from '../report.ts';
import { rewrapSealed } from '../rewrap.ts';
import { failureNote, readV4Json, V4InputError } from '../v4/documents.ts';
import { V4_MCP_OAUTH, V4_MCP_OAUTH_SECRETS, V4McpOAuthDocument } from '../v4/mcp.ts';
import type { Step } from './index.ts';

export const V5_MCP_OAUTH = join('state/mcp', MCP_OAUTH_STATE.path);
/** MCP's sealed document (`MCP_OAUTH_SECRETS`, lead decision 2026-11-07); the Vault key opens it. */
export const V5_MCP_OAUTH_SECRETS = join('state/mcp', MCP_OAUTH_SECRETS.state.path);
const V4_VAULT_KEY = 'state/secrets.key';

export const mcpStep: Step = {
  id: 'mcp',
  title: 'MCP sign-ins (records, and the sealed refresh tokens moved with the vault key)',
  owner: ['plugin-mcp'],
  reads: [V4_MCP_OAUTH],
  sealed: [V4_MCP_OAUTH_SECRETS],
  notCarried: [
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
    const home = ctx.v4.home;
    const sealed: { file: string; bytes: number }[] = [];
    const base = () => ({ id: this.id, title: this.title, notCarried: this.notCarried, sealed });
    try {
      const notes: string[] = ctx.dryRun ? ['dry run: nothing written'] : [];
      // The sealed half: its envelope re-labelled, every entry's bytes kept; never decrypted.
      const secrets = await lstat(join(home, V4_MCP_OAUTH_SECRETS)).catch(() => undefined);
      if (secrets !== undefined) {
        // The entries move unchanged, so they open in v5 only under v4's AAD (the entry name alone).
        if (MCP_OAUTH_SECRETS.additionalData !== '' || !MCP_OAUTH_SECRETS.stamped)
          throw new V4InputError(
            `${V4_MCP_OAUTH_SECRETS}: v5 MCP seals with another AAD or shape; a converter update is needed`,
          );
        if ((await lstat(join(home, V4_VAULT_KEY)).catch(() => undefined)) === undefined)
          throw new V4InputError(
            `${V4_MCP_OAUTH_SECRETS} exists but the vault key ${V4_VAULT_KEY} that seals it does not`,
          );
        if (ctx.dryRun) sealed.push({ file: V5_MCP_OAUTH_SECRETS, bytes: secrets.size });
        else {
          const moved = await rewrapSealed(join(home, V4_MCP_OAUTH_SECRETS), ctx.v5.resolve(V5_MCP_OAUTH_SECRETS), {
            stamped: MCP_OAUTH_SECRETS.stamped,
            schema: SealedDocumentSchema,
          });
          sealed.push({ file: V5_MCP_OAUTH_SECRETS, bytes: (await lstat(moved.to)).size });
        }
      }

      const value = await readV4Json(home, join(home, V4_MCP_OAUTH));
      if (value === undefined)
        return {
          ...base(),
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
        ...base(),
        status: 'converted',
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
        kept: [
          { what: 'MCP sign-ins (connections)', count: Object.keys(document.data.connections).length },
          { what: 'MCP client registrations', count: registrations },
        ],
      };
    } catch (error) {
      return {
        ...base(),
        status: 'failed',
        note: failureNote(error, 'cannot convert the MCP sign-in state'),
        kept: [],
      };
    }
  },
};
