import type { ChildEnvironment, FerretId, SecretResolver } from '@ferretry/kernel/contract';
import type { FerretState } from '@ferretry/core-ferrets/contract';
import { implementDaemon, type Needer, perNeeder } from '@ferretry/kernel/manifest';
import { err, ok, type Result } from '@ferretry/std';
import manifest from '../manifest.ts';
import {
  type AuthorizedOutcome,
  type CredentialPlacement,
  CredentialPlacementSchema,
  type OutboundHttpRequest,
  OutboundHttpRequestSchema,
  HoldsChanged,
  RedactionSources,
  ProfileSecrets,
  SecretsChanged,
  type SecretName,
  SecretUseRequestSchema,
  type SecretUseCommand,
  type SecretUseRefusal,
  type SecretUseResult,
  type VaultApi,
  VaultConfigFile,
} from '../contract/index.ts';
import { KernelOutboundTransport } from './adapters/secrets/kernel-outbound-transport.ts';
import { ConfigSecretRecipes } from './adapters/secrets/config-secret-recipes.ts';
import { KernelSealedDocuments } from './adapters/secrets/kernel-sealed-documents.ts';
import { kernelSealedFiles } from './adapters/secrets/kernel-sealed-files.ts';
import { KernelSecretChildRunner } from './adapters/secrets/kernel-secret-child-runner.ts';
import { FileSecretDocumentStore } from './adapters/secrets/file-secret-document-store.ts';
import { WebCryptoCloneCrypto } from './adapters/secrets/webcrypto-clone-crypto.ts';
import { FileSecretKey, WebCryptoSecretCipher } from './adapters/secrets/webcrypto-secret-cipher.ts';
import { quarantineOverOutputGuard } from './adapters/inputs/output-guard.ts';
import { buildInputs } from './inputs.ts';
import type { AccountId, TwoFactorId } from './lib/inputs/borrowed.ts';
import { INPUT_ASK_SOURCE } from './adapters/inputs/asks.ts';
import type { AgendaId } from './lib/inputs/wire.ts';
import { EphemeralAwareRedactor } from './lib/inputs/ephemeral-redactor.ts';
import { EphemeralValues } from './lib/inputs/ephemeral-values.ts';
import { InputRequestError } from './lib/inputs/errors.ts';
import { secretRouteHandlers } from './lib/runtime/mounts/secrets.ts';
import { OutboundProviderAuthorizer } from './lib/secrets/authorizer.ts';
import {
  isCoreNeeder,
  isMintedSecret,
  mayRunProgram,
  mayTouchSecret,
  mayUseSecret,
  namesAreNarrowed,
  reachableHosts,
  secretsNamedBy,
  UndeclaredProgramError,
  UndeclaredSecretError,
} from './lib/secrets/reach.ts';
import { ChildEnvironments, namesSecret } from './lib/secrets/child-environments.ts';
import { type SecretCloneIdentitySource, SecretExportService, SecretImportService } from './lib/secrets/clone.ts';
import { HoldRegistry } from './lib/secrets/output-guard.ts';
import { launchEnvironment } from './lib/secrets/policy.ts';
import { VaultRedaction } from './lib/secrets/read-scope.ts';
import { DeclaredMaskSource } from './lib/secrets/mask-source.ts';
import { combinedValues, SecretRedactor } from './lib/secrets/redaction.ts';
import { UnknownSecretError } from './lib/secrets/types.ts';
import { SecretUseError, SecretUseService } from './lib/secrets/use.ts';
import { SecretDirectory, SecretVault } from './lib/secrets/vault.ts';

/**
 * The machine's own identity, for copying secrets between machines. GAP (for the lead): the kernel holds the
 * identity key (spine D17) and offers no port to sign with it, so a copy answers `identity_unavailable` (503) until
 * one exists; nothing here reads `state/kernel/identity.json` around the kernel.
 */
const IDENTITY_NOT_OFFERED: SecretCloneIdentitySource = { load: async () => undefined };

/** The one plugin that looks at a page's number and a terminal's prompt for a phone approval, and may ask whether a ferret steered. */
const PHONE_APPROVAL_LOOKER = 'accounts';
/** The plugins whose request tools carry a ferret's `push: true` raise (Terminals' does not serve one yet). */
const PHONE_APPROVAL_RAISERS: readonly string[] = ['browsers'];

/**
 * The Vault's daemon half (§2.2): the sealed store and key (byte for byte, spine D16), `${secret:NAME}` use, the
 * authorized fetch, the read-scoped redaction and the output guard. Every value-holder is built HERE and nowhere
 * else, so the list of things that can open the vault is this function (S7):
 *
 *   redaction · use · child environments (the fleet launch's, now `childEnvironment`) · authorized fetch · export ·
 *   the kernel's own `${secret:NAME}` lookup (`secretResolver`, kernel-bound: no route, tool or half is handed it).
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
    // The operator's `secretEnvironment` recipes are `config/vault.yaml` (`VaultConfigFile`), read on every use so an
    // edit lands without a restart; the one adapter is both the recipe source and the listing's references, so the two
    // never disagree. GAP (for the lead): the fleet accounts' references (Accounts' and Logins' code) are not offered
    // by those ports yet, so the listing shows the recipes' only.
    const recipes = new ConfigSecretRecipes(() => kernel.config.file(VaultConfigFile)?.secretEnvironment ?? {});
    const uses = new SecretUseService(
      vault,
      new KernelSecretChildRunner(kernel.spawn, kernel.clock),
      environments,
      recipes,
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
     *
     * The handle records the plugin it was minted for (`requester`: the needer this port was built for) and whether its
     * `PATH` as asked named a secret, so `searchPathOf` (Q7) answers only the kernel's readers for that plugin and
     * never a secret-derived PATH. A call with no requester mints a handle no plugin may search.
     */
    const mintChildEnvironment = async (
      env: Readonly<Record<string, string>>,
      requester: string | undefined,
    ): Promise<Result<ChildEnvironment, { readonly unknown: readonly SecretName[] }>> => {
      // ONE reading of the caller's object: the PATH judged for a secret reference is the PATH that is resolved.
      const asked: Readonly<Record<string, string>> = Object.freeze({ ...env });
      const values = await vault.values();
      const resolved = launchEnvironment(asked, values);
      if (!resolved.ok) return err({ unknown: resolved.unknown });
      return ok(
        environments.mint(resolved.value, {
          ...(requester === undefined ? {} : { requester }),
          pathFromSecret: namesSecret(asked.PATH),
        }),
      );
    };
    const childEnvironment = async (
      _ferret: FerretId,
      env: Readonly<Record<string, string>>,
    ): Promise<Result<ChildEnvironment, { readonly unknown: readonly SecretName[] }>> =>
      await mintChildEnvironment(env, undefined);

    /**
     * The kernel's own `${secret:NAME}` lookup (`kernel.secrets`): the value for a NAME, as today's consumers took it
     * (`(await secretVault.values()).get(name)`). A store that cannot be opened raises, which the kernel answers as
     * `unknown`. Held by the kernel alone: no route, tool or other plugin is handed it.
     */
    const secretResolver: SecretResolver = {
      resolve: async name => (await vault.values()).get(name as SecretName),
    };

    const full: VaultApi = {
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
      // The input card a 2FA seed is set up from (Accounts, I173): where the daemon saw its target, and "use it now".
      cardTarget: requestId => inputs.service.cardTarget(requestId),
      useNow: async (requestId, use) =>
        await inputs.service.useNow(requestId, {
          ...use,
          account: use.account as AccountId,
          factor: use.factor as TwoFactorId,
        }),
      // Approve on your phone: the looks Accounts' approval makes and the raise a request tool hands on. `apiFor`
      // narrows who is handed which; a needer outside both lists is handed none (fail closed).
      pushNumber: async (ferret, key) => await inputs.phoneReach.pushNumber(ferret, key),
      observeTerminal: async (ferret, key) => await inputs.phoneReach.observeTerminal(ferret, key),
      tainted: (ferret, kind, since) => inputs.phoneReach.tainted(ferret, kind, since),
      raisePhoneApproval: async (ferret, ask) => await inputs.phoneReach.raisePhoneApproval(ferret, ask),
    };

    /**
     * THE PORT EACH PLUGIN IS HANDED (§3.7), built once per needing plugin by the kernel. A core caller gets the
     * Vault's own reach; any other plugin gets the same port with the three calls that spend something narrowed to
     * what it is already allowed: a host its manifest's `network` names, a secret its manifest or its own records
     * name ({@link mayUseSecret}), a program its manifest's `spawn` names. A request outside is refused the way
     * today's Vault refuses a host, secret or program it does not allow.
     */
    /** The names a runtime's profile references, from Runtimes (the hook's one provider); none when it is off or fails. */
    const profileReferences = async (runtime: string): Promise<ReadonlySet<string>> => {
      try {
        if (ctx.hooks.declaredProvider(ProfileSecrets, 'profiles') === undefined) return new Set();
        const provider = ctx.hooks.provider(ProfileSecrets, 'profiles');
        return provider === 'unavailable' ? new Set() : new Set(await provider.references(runtime));
      } catch {
        return new Set();
      }
    };

    const apiFor = (needer: Needer): VaultApi => {
      // Every needer's handles name it as their requester (`searchPathOf`), the core ones included.
      const ownChildEnvironment: VaultApi['childEnvironment'] = async (_ferret, env) =>
        await mintChildEnvironment(env, needer.id);
      if (isCoreNeeder(needer)) return { ...full, childEnvironment: ownChildEnvironment };
      // The phone approval's reach is by name: the service that looks (Accounts) and the tool that raises (Browsers).
      // Every other needer is handed none of it, so a plugin cannot read a page's number or the prompt of
      // a terminal, or raise an approval, by holding the Vault port.
      const { pushNumber, observeTerminal, tainted, raisePhoneApproval, ...rest } = full;
      return {
        ...rest,
        ...(needer.id === PHONE_APPROVAL_LOOKER ? { pushNumber, observeTerminal, tainted } : {}),
        ...(PHONE_APPROVAL_RAISERS.includes(needer.id) ? { raisePhoneApproval } : {}),
        // LIST reach: the secrets this needer may use or mints itself. WRITE reach is narrower: only the names it MINTS, so a
        // plugin cannot overwrite or delete a secret it merely uses (an owner's GITHUB_TOKEN named in its records), nor see
        // the owner's others (credential substitution, S12).
        names: async () =>
          namesAreNarrowed(needer)
            ? (await full.names()).filter(secret => mayTouchSecret(needer, secret.name))
            : await full.names(),
        has: async name => mayTouchSecret(needer, String(name)) && (await full.has(name)),
        put: async (name, value) => {
          const secret = String(name);
          if (!isMintedSecret(needer, secret)) throw new UndeclaredSecretError(needer, secret, 'write');
          await full.put(secret as SecretName, value);
        },
        remove: async name => {
          const secret = String(name);
          if (!isMintedSecret(needer, secret)) throw new UndeclaredSecretError(needer, secret, 'remove');
          return await full.remove(secret as SecretName);
        },
        // Every narrowed call reads what the caller passed ONCE, into plain data of its own, checks that copy and uses
        // only that copy: a getter on the caller's object cannot show a declared value to the check and another to the use.
        run: async (asked, ferret) => {
          const command = SecretUseRequestSchema.parse(asked);
          const program = command.command[0];
          if (program === undefined || !mayRunProgram(needer, program))
            throw new UndeclaredProgramError(needer, program ?? '');
          if (!secretsNamedBy(command).every(name => mayUseSecret(needer, name))) return err('unknown_secret');
          return await full.run(command, ferret);
        },
        authorizeFetch: async (name, hostAllowlist, request, placement) => {
          const secret = String(name);
          const hosts = [...hostAllowlist].map(String);
          // The request and the placement are PARSED once into plain data; only that copy is checked and sent (S162).
          const copy = OutboundHttpRequestSchema.safeParse(request);
          const placed = placement === undefined ? undefined : CredentialPlacementSchema.safeParse(placement);
          if (!copy.success || (placed !== undefined && !placed.success)) return { kind: 'refused' };
          if (!mayUseSecret(needer, secret)) return { kind: 'refused' };
          return await full.authorizeFetch(
            secret as SecretName,
            reachableHosts(needer, hosts),
            copy.data,
            placed?.data,
          );
        },
        childEnvironment: async (ferret, asked) => {
          const env = SecretUseRequestSchema.shape.env.parse({ ...asked });
          const refused = secretsNamedBy({ secrets: [], env }).filter(name => !mayUseSecret(needer, name));
          if (refused.length > 0) return err({ unknown: refused });
          return await ownChildEnvironment(ferret, env);
        },
        ...(needer.permissions.profileSecrets === true
          ? {
              // One command for one runtime: what the needer may use, plus the names that runtime's profile references,
              // asked of Runtimes AFRESH for this call and kept by nothing. No value is returned; the kernel opens the handle.
              childEnvironmentForRuntime: async (runtime, asked) => {
                const env = SecretUseRequestSchema.shape.env.parse({ ...asked });
                const granted = await profileReferences(runtime);
                const refused = secretsNamedBy({ secrets: [], env }).filter(
                  name => !mayUseSecret(needer, name) && !granted.has(name),
                );
                if (refused.length > 0) return err({ unknown: refused });
                return await ownChildEnvironment('runtime-check' as FerretId, env);
              },
            }
          : {}),
      };
    };

    return {
      routes: {
        ...secretRouteHandlers({ directory, references: recipes, uses, imports, exports, changed }),
        ...inputs.routes,
      },
      tools: { ...inputs.tools },
      provides: {
        vault: perNeeder(apiFor),
        outputGuard: holds,
        inputHolds: inputs.holds,
        redaction,
        childEnvironments: environments,
        // Each plugin's OWN sealed documents, over the state port the kernel rooted at its folder (change C).
        sealedDocuments: new KernelSealedDocuments(key, kernel.clock),
        secretResolver,
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
