import type { ChildEnvironment, FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { err, ok, type Result } from '@ferretry/std';
import manifest from '../manifest.ts';
import {
  type AuthorizedOutcome,
  type CredentialPlacement,
  type OutboundHttpRequest,
  SecretsChanged,
  type SecretName,
  type SecretUseCommand,
  type SecretUseRefusal,
  type SecretUseResult,
  secretReferencesIn,
  type VaultApi,
} from '../contract/index.ts';
import { KernelOutboundTransport } from './adapters/secrets/kernel-outbound-transport.ts';
import { kernelSealedFiles } from './adapters/secrets/kernel-sealed-files.ts';
import { KernelSecretChildRunner } from './adapters/secrets/kernel-secret-child-runner.ts';
import { FileSecretDocumentStore } from './adapters/secrets/file-secret-document-store.ts';
import { WebCryptoCloneCrypto } from './adapters/secrets/webcrypto-clone-crypto.ts';
import { FileSecretKey, WebCryptoSecretCipher } from './adapters/secrets/webcrypto-secret-cipher.ts';
import { inputs } from './lib/inputs.ts';
import { secretRouteHandlers } from './lib/runtime/mounts/secrets.ts';
import { OutboundProviderAuthorizer } from './lib/secrets/authorizer.ts';
import { ChildEnvironments } from './lib/secrets/child-environments.ts';
import { type SecretCloneIdentitySource, SecretExportService, SecretImportService } from './lib/secrets/clone.ts';
import { HoldRegistry } from './lib/secrets/output-guard.ts';
import { expandSecretReferences } from './lib/secrets/policy.ts';
import { VaultRedaction } from './lib/secrets/read-scope.ts';
import { combinedValues } from './lib/secrets/redaction.ts';
import { UnknownSecretError } from './lib/secrets/types.ts';
import { NO_RECIPES, SecretUseError, SecretUseService } from './lib/secrets/use.ts';
import { SecretDirectory, SecretVault } from './lib/secrets/vault.ts';
import { NO_REFERENCES } from './lib/secrets/view.ts';

/**
 * The machine's own identity, for copying secrets between machines. GAP (for the lead): the kernel holds the
 * identity key (spine D17) and offers no port to sign with it, so a copy answers `identity_unavailable` (503) until
 * one exists; nothing here reads `state/kernel/identity.json` around the kernel.
 */
const IDENTITY_NOT_OFFERED: SecretCloneIdentitySource = { load: async () => undefined };

/**
 * The Vault's daemon half (§2.2): the sealed store and key (byte for byte, spine D16), `${secret:NAME}` use, the
 * authorized fetch, the read-scoped redaction and the output guard. Every value-holder is built HERE and nowhere
 * else, so the list of things that can open the vault is this function (S7):
 *
 *   redaction · use · child environments (the fleet launch's, now `childEnvironment`) · authorized fetch · export.
 *
 * The routes are handed `SecretDirectory` and the services, never a `SecretVault` (S6).
 */
export default implementDaemon(manifest, {
  build(ctx) {
    const { kernel } = ctx;
    const files = kernelSealedFiles(kernel.state);
    const store = new FileSecretDocumentStore(files);
    const cipher = new WebCryptoSecretCipher(new FileSecretKey(files));
    const directory = new SecretDirectory(store, cipher, kernel.clock);
    const vault = new SecretVault(store, cipher);
    const environments = new ChildEnvironments();
    const holds = new HoldRegistry();

    // ── the input half (vault-b): ONE call; what it answers is wired below ──────────────────────────────────────
    const input = inputs({ directory, holds });

    const redaction = new VaultRedaction(combinedValues(vault, ...input.maskSources));
    // GAP (for the lead): today's operator `secretEnvironment` recipes and the reference sources (recipes, fleet
    // accounts) were composed here from Accounts' and Logins' code; until those ports offer them, a use gets exactly
    // the secrets it named and the listing shows no configured references.
    const uses = new SecretUseService(
      vault,
      new KernelSecretChildRunner(kernel.spawn, kernel.clock),
      environments,
      NO_RECIPES,
    );
    const authorizer = new OutboundProviderAuthorizer(vault, new KernelOutboundTransport(kernel.fetch, kernel.clock));
    const crypto = new WebCryptoCloneCrypto();
    const imports = new SecretImportService({ crypto, identity: IDENTITY_NOT_OFFERED, directory, clock: kernel.clock });
    const exports = new SecretExportService({ crypto, identity: IDENTITY_NOT_OFFERED, vault, clock: kernel.clock });

    let generation = 0;
    const changed = (): void => {
      generation += 1;
      kernel.events.publish(SecretsChanged, { generation });
    };

    const run = async (
      command: SecretUseCommand,
      _ferret?: FerretId,
    ): Promise<Result<SecretUseResult, SecretUseRefusal>> => {
      try {
        return ok(await uses.run(command));
      } catch (error) {
        if (error instanceof SecretUseError) return err(error.refusal);
        if (error instanceof UnknownSecretError) return err('unknown_secret');
        throw error;
      }
    };

    /** `${secret:NAME}` in a ferret child's environment (S62–S64): every name resolved, or the launch refused. */
    const childEnvironment = async (
      _ferret: FerretId,
      env: Readonly<Record<string, string>>,
    ): Promise<Result<ChildEnvironment, { readonly unknown: readonly SecretName[] }>> => {
      const values = await vault.values();
      const unknown = [...new Set(Object.values(env).flatMap(value => secretReferencesIn(value)))].filter(
        name => !values.has(name),
      );
      // A missing referenced secret refuses the launch, never an empty string (S64).
      if (unknown.length > 0) return err({ unknown });
      const resolved: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) resolved[key] = expandSecretReferences(value, values);
      return ok(environments.mint(resolved));
    };

    const api: VaultApi = {
      names: async () => await directory.list(),
      has: async name => (await directory.list()).some(secret => secret.name === name),
      put: async (name, value) => {
        await directory.put(name, value);
        changed();
      },
      remove: async name => {
        const removed = await directory.remove(name);
        if (removed) changed();
        return removed;
      },
      run,
      authorizeFetch: async (
        name: SecretName,
        hostAllowlist: readonly string[],
        request: OutboundHttpRequest,
        placement?: CredentialPlacement,
      ): Promise<AuthorizedOutcome> => await authorizer.send(name, hostAllowlist, request, placement),
      childEnvironment,
      raiseInput: input.raiseInput,
      cancelInput: input.cancelInput,
      inputState: input.inputState,
    };

    return {
      routes: secretRouteHandlers({ directory, references: NO_REFERENCES, uses, imports, exports, changed }),
      provides: {
        vault: api,
        outputGuard: holds,
        inputHolds: input.inputHolds,
        redaction,
        childEnvironments: environments,
      },
      hooks: { 'ask.sources:input': input.askSource },
    };
  },
});
