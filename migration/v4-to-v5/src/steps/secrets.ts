/**
 * The steps that carry secrets: the Vault and the daemon identity. Neither ever decrypts or prints anything.
 *
 * - Vault (spine D16): `state/secrets.key` → `state/vault/vault.key` byte for byte (today's key format IS v5's);
 *   `state/secrets.json` → `state/vault/vault.json` with only the envelope re-labelled (`src/rewrap.ts`).
 * - Identity (spine D17): `state/daemon-identity.json` → `state/kernel/identity.json` byte for byte; v5 keeps today's
 *   layout as its format 1, so every paired device keeps working.
 *
 * The other sealed documents that share today's key move with their owners' steps (Accounts: login secrets; MCP:
 * OAuth secrets; Catalogs: link keys), each into its own `store: 'secret'` file under the same `vault.key`.
 */
import { VaultDocumentSchema, VaultFile, VaultKeyFile } from '@ferretry/core-vault/contract';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { StepReport } from '../report.ts';
import { rewrapSealed } from '../rewrap.ts';
import { moveSealed } from '../sealed.ts';
import type { Step, StepContext } from './index.ts';

/** `packages/core/kernel/host/identity.ts` `IDENTITY_FILE` (host-internal, so named here, not imported). */
export const V5_IDENTITY_FILE = 'state/kernel/identity.json';
export const V5_VAULT_FILE = join('state', 'vault', VaultFile.path);
export const V5_VAULT_KEY_FILE = join('state', 'vault', VaultKeyFile.path);

async function present(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined)) !== undefined;
}

async function sizeOf(path: string): Promise<number> {
  return (await lstat(path)).size;
}

export const vaultStep: Step = {
  id: 'vault',
  title: 'Secrets (sealed vault and key, moved unopened)',
  owner: ['core-vault'],
  reads: [],
  sealed: ['state/secrets.key', 'state/secrets.json'],
  notCarried: [{ what: 'live input requests', why: 'they belong to a moment that has passed' }],
  async run(ctx: StepContext): Promise<StepReport> {
    const key = join(ctx.v4.state, 'secrets.key');
    const document = join(ctx.v4.state, 'secrets.json');
    const base = { id: this.id, title: this.title, notCarried: this.notCarried };
    const [hasKey, hasDocument] = [await present(key), await present(document)];
    if (!hasKey && !hasDocument) {
      ctx.loginKeys?.markVaultMoved();
      return { ...base, status: 'converted', note: 'this home has no vault', kept: [], sealed: [] };
    }
    if (!hasKey)
      return {
        ...base,
        status: 'failed',
        note: `${document} exists but its key ${key} does not`,
        kept: [],
        sealed: [],
      };

    const sealed: { file: string; bytes: number }[] = [];
    if (ctx.dryRun) {
      sealed.push({ file: V5_VAULT_KEY_FILE, bytes: await sizeOf(key) });
      if (hasDocument) sealed.push({ file: V5_VAULT_FILE, bytes: await sizeOf(document) });
      ctx.loginKeys?.markVaultMoved();
      return { ...base, status: 'converted', note: 'dry run: nothing written', kept: [], sealed };
    }
    const movedKey = await moveSealed(key, ctx.v5.resolve(V5_VAULT_KEY_FILE));
    sealed.push({ file: V5_VAULT_KEY_FILE, bytes: movedKey.bytes });
    let entries = 0;
    if (hasDocument) {
      const rewrapped = await rewrapSealed(document, ctx.v5.resolve(V5_VAULT_FILE), {
        stamped: true,
        schema: VaultDocumentSchema,
      });
      entries = rewrapped.entries;
      sealed.push({ file: V5_VAULT_FILE, bytes: await sizeOf(rewrapped.to) });
    }
    ctx.loginKeys?.markVaultMoved();
    return { ...base, status: 'converted', kept: [{ what: 'sealed secrets', count: entries }], sealed };
  },
};

export const identityStep: Step = {
  id: 'identity',
  title: 'Daemon identity (the key every paired device pins), moved unopened',
  owner: ['kernel'],
  reads: [],
  sealed: ['state/daemon-identity.json'],
  notCarried: [],
  async run(ctx: StepContext): Promise<StepReport> {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried };
    if (!(await present(ctx.v4.daemonIdentity)))
      return { ...base, status: 'converted', note: 'this home never minted an identity', kept: [], sealed: [] };
    if (ctx.dryRun)
      return {
        ...base,
        status: 'converted',
        note: 'dry run: nothing written',
        kept: [],
        sealed: [{ file: V5_IDENTITY_FILE, bytes: await sizeOf(ctx.v4.daemonIdentity) }],
      };
    const moved = await moveSealed(ctx.v4.daemonIdentity, ctx.v5.resolve(V5_IDENTITY_FILE));
    return {
      ...base,
      status: 'converted',
      kept: [{ what: 'daemon identity', count: 1 }],
      sealed: [{ file: V5_IDENTITY_FILE, bytes: moved.bytes }],
    };
  },
};
