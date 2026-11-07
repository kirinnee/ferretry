import type { ChildEnvironment, FerretId } from '@ferretry/kernel/contract';
import type { FerretState } from '@ferretry/core-ferrets/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { err, ok, type Result } from '@ferretry/std';
import manifest from '../manifest.ts';
import {
  type AuthorizedOutcome,
  type CredentialPlacement,
  type OutboundHttpRequest,
  HoldsChanged,
  RedactionSources,
  SecretsChanged,
  type SecretName,
  type SecretUseCommand,
  type SecretUseRefusal,
  type SecretUseResult,
  type VaultApi,
} from '../contract/index.ts';
import { KernelOutboundTransport } from './adapters/secrets/kernel-outbound-transport.ts';
import { KernelSealedDocuments } from './adapters/secrets/kernel-sealed-documents.ts';
import { kernelSealedFiles } from './adapters/secrets/kernel-sealed-files.ts';
import { KernelSecretChildRunner } from './adapters/secrets/kernel-secret-child-runner.ts';
import { FileSecretDocumentStore } from './adapters/secrets/file-secret-document-store.ts';
import { WebCryptoCloneCrypto } from './adapters/secrets/webcrypto-clone-crypto.ts';
import { FileSecretKey, WebCryptoSecretCipher } from './adapters/secrets/webcrypto-secret-cipher.ts';
import { quarantineOverOutputGuard } from './adapters/inputs/output-guard.ts';
import { buildInputs } from './inputs.ts';
import { INPUT_ASK_SOURCE } from './adapters/inputs/asks.ts';
import type { AgendaId } from './lib/inputs/wire.ts';
import { EphemeralAwareRedactor } from './lib/inputs/ephemeral-redactor.ts';
import { EphemeralValues } from './lib/inputs/ephemeral-values.ts';
import { InputRequestError } from './lib/inputs/errors.ts';
import { secretRouteHandlers } from './lib/runtime/mounts/secrets.ts';
import { OutboundProviderAuthorizer } from './lib/secrets/authorizer.ts';
import { ChildEnvironments } from './lib/secrets/child-environments.ts';
import { type SecretCloneIdentitySource, SecretExportService, SecretImportService } from './lib/secrets/clone.ts';
import { HoldRegistry } from './lib/secrets/output-guard.ts';
import { launchEnvironment } from './lib/secrets/policy.ts';
import { VaultRedaction } from './lib/secrets/read-scope.ts';
import { DeclaredMaskSource } from './lib/secrets/mask-source.ts';
import { combinedValues, SecretRedactor } from './lib/secrets/redaction.ts';
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
 * The vault KEY has one more holder, as today (the MCP sign-in's and the accounts' second documents, the link keys):
 * `sealedDocuments`, which opens only the calling plugin's own documents and never `vault.json`.
 *
 * The routes are handed `SecretDirectory` and the services, never a `SecretVault` (S6).
 */
export default implementDaemon(manifest, {
  build(ctx) {
    const { kernel } = ctx;
    const files = kernelSealedFiles(kernel.state);
    const store = new FileSecretDocumentStore(files);
    const key = new FileSecretKey(files);
    const cipher = new WebCryptoSecretCipher(key);
    const directory = new SecretDirectory(store, cipher, kernel.clock);
    const vault = new SecretVault(store, cipher);
    const environments = new ChildEnvironments();
    const holds = new HoldRegistry();

    const inputClock = { now: () => kernel.clock.nowMs() };
    const values = new EphemeralValues(inputClock);
    const quarantine = quarantineOverOutputGuard(inputClock, holds, event =>
      kernel.events.publish(HoldsChanged, event),
    );
    // As today: close every surface before exposing readers, until durable holds have been replayed (I82).
    quarantine.lock();
    // Declaration metadata names even a failed or stopped provider, so only an undeclared source masks nothing; a
    // declared one that is not live is unavailable and refuses (S19).
    const contributedMasks = new DeclaredMaskSource(() => {
      if (ctx.hooks.declaredProvider(RedactionSources, 'source') === undefined) return 'absent';
      return ctx.hooks.provider(RedactionSources, 'source');
    });
    const maskSources = combinedValues(vault, contributedMasks);
    const masks = new EphemeralAwareRedactor(new SecretRedactor(maskSources), values);
    const redaction = new VaultRedaction(maskSources, scrub => masks.scope(scrub));
    const redact = async (text: string): Promise<string> => await masks.redact(text);
    const secretStore = directory;
    // Ferrets already needs Vault: lifecycle events carry status without a reverse needs edge (I108).
    // Unknown or unreadable status keeps masking, as today; only known ends release the typed values.
    const ferretStates = new Map<string, FerretState | 'gone'>();
    const ferretEnded = async (ferret: FerretId): Promise<boolean> => {
      const state = ferretStates.get(ferret);
      return state === 'stopped' || state === 'gone';
    };
    const inputs = buildInputs(ctx, { values, quarantine, redact, secretStore, ferretEnded });
    // GAP (for the lead): today's operator `secretEnvironment` recipes and the reference sources (recipes, fleet
    // accounts) were composed here from Accounts' and Logins' code; until those ports offer them, a use gets exactly
    // the secrets it named and the listing shows no configured references.
    const uses = new SecretUseService(
      vault,
      new KernelSecretChildRunner(kernel.spawn, kernel.clock),
      environments,
      NO_RECIPES,
      masks,
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

    /**
     * `${secret:NAME}` in a ferret child's environment (S62–S64): every name resolved, or the launch refused. A
     * variable whose whole value is `${secret?:NAME}` is set when held and left out when not (`launchEnvironment`).
     */
    const childEnvironment = async (
      _ferret: FerretId,
      env: Readonly<Record<string, string>>,
    ): Promise<Result<ChildEnvironment, { readonly unknown: readonly SecretName[] }>> => {
      const values = await vault.values();
      const resolved = launchEnvironment(env, values);
      if (!resolved.ok) return err({ unknown: resolved.unknown });
      return ok(environments.mint(resolved.value));
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
      raiseInput: async (ferret, raise) => {
        try {
          return ok(await inputs.service.raiseForFerret(ferret, raise));
        } catch (error) {
          if (error instanceof InputRequestError) return err(error.message);
          throw error;
        }
      },
      cancelInput: async (ferret, id) => await inputs.service.cancelForFerret(ferret, id),
      inputState: async id => await inputs.service.requestState(id),
      // What a ferret did to a page and where page scripts ran, told by Browsers (lead DECISIONS-2 #5, I98–I100):
      // the login observer's act notes and the machine-wide script taint a page card's lock reads.
      pageActed: (ferret, script) => inputs.observer?.acted(ferret, 'browser', script) ?? { placed: () => undefined },
      scriptRunning: () => inputs.scripts.running(),
      scriptedOn: host => inputs.scripts.scriptedOn(host),
    };

    return {
      routes: {
        ...secretRouteHandlers({ directory, references: NO_REFERENCES, uses, imports, exports, changed }),
        ...inputs.routes,
      },
      tools: { ...inputs.tools },
      provides: {
        vault: api,
        outputGuard: holds,
        inputHolds: inputs.holds,
        redaction,
        childEnvironments: environments,
        // Each plugin's OWN sealed documents, over the state port the kernel rooted at its folder (change C).
        sealedDocuments: new KernelSealedDocuments(key, kernel.clock),
      },
      hooks: { 'ask.sources:input': inputs.askSource },
      subscribers: {
        'ferrets.changed': async ({ ferret, state, gone }) => {
          if (gone === true) ferretStates.set(ferret, 'gone');
          else if (state !== undefined) ferretStates.set(ferret, state);
          if (await ferretEnded(ferret as FerretId)) await inputs.service.sessionEnded(ferret);
        },
        'asks.changed': async ({ ferret, askId, state }) => {
          if (state !== 'closed') return;
          const ask = await ctx.needs.asks.get({ ferret, id: askId });
          if (ask?.source !== INPUT_ASK_SOURCE || ask.state !== 'closed' || ask.ferret === undefined) return;
          // As today, only the request's current pending card is ended; our own final-card close is a no-op.
          await inputs.service.cardDismissed(ask.ferret, askId as string as AgendaId);
        },
      },
    };
  },
});
