/**
 * Logins' daemon half (§2.3): the AI provider sign-ins, API keys, proxies and endpoints ferrets spend.
 *
 * `build` wires the services this plugin owns — the harness sign-in flows, the logins list with Check now and Test, the
 * provider presets, the model catalogs and the local-models read — over the kernel's ports, and hands back the eleven
 * routes, the `logins` read model and the five `logins:*` kinds. Nothing here holds a token: a harness writes its own
 * sign-in into its own store, and an environment login names its secrets as `${secret:NAME}` in a file.
 */
import { implementDaemon, type Needer, neederMayReach, perNeeder } from '@ferretry/kernel/manifest';
import { type Instant, milliseconds } from '@ferretry/std';
import { CredentialPlacementSchema, OutboundHttpRequestSchema } from '@ferretry/core-vault/contract';
import manifest from '../manifest.ts';
import {
  type LoginId,
  type LoginsApi,
  LOGINS_CONFIG,
  LoginChanged,
  LoginSignedIn,
  ModelsChanged,
} from '../contract/index.ts';
import { HostedModelCatalog, StateModelCatalogCache } from './adapters/models/index.ts';
import { spendHostsOf, spendableHosts, spendSecretOf } from './lib/credentials/spend-secret.ts';
import { AuthorizedProviderProbe, BoundedTransport } from './adapters/provider-probe/index.ts';
import { deliverCodexCallback } from './adapters/harness-login/callback-delivery.ts';
import { harnessLoginTimer, spawnHarnessLoginChild } from './adapters/harness-login/login-child.ts';
import { systemPortHolders } from './adapters/harness-login/port-holders.ts';
import { OwnedLoginStore } from './adapters/credentials/owned-store.ts';
import { AnthropicUsageProbe, quotaFetch } from './adapters/credentials/anthropic-usage-probe.ts';
import { CodexUsageProbe } from './adapters/credentials/codex-usage-probe.ts';
import { codexTokenRefresh } from './adapters/credentials/token-refresh.ts';
import { parseModelCatalog } from './lib/catalog/catalog.ts';
import { suggestedOllamaModel } from './lib/local-models/ollama.ts';
import { LocalModelsService } from './lib/local-models/service.ts';
import { CREDENTIAL_LIST_FRESH_MS, FleetCredentialsService } from './lib/credentials/credentials-service.ts';
import { CredentialStatusService } from './lib/credentials/credential-status.ts';
import { HarnessLoginService } from './lib/harness-login/service.ts';
import { loginKinds } from './lib/kinds.ts';
import { ModelCatalogService } from './lib/models/service.ts';
import { PublishedModelCatalogService } from './lib/models/published.ts';
import { modelCatalogsView, type PublishedCatalogState } from './lib/models/view.ts';
import { presetFromFile, type ProviderPreset, type ProviderPresetFile } from './lib/presets/schema.ts';
import { ProviderPresetService } from './lib/provider-probe/presets.ts';
import { ProviderProbeService } from './lib/provider-probe/service.ts';
import { LoginChangeService } from './lib/changes/service.ts';
import { changeRoutes } from './lib/routes/changes.ts';
import { loginRoutes } from './lib/routes/logins.ts';
import { modelRoutes } from './lib/routes/models.ts';
import { signInRoutes } from './lib/routes/sign-in.ts';
import { HOSTED_APP_ORIGIN, HOSTED_APP_RELEASE_KEY } from './lib/shared/hosted.ts';
import { endpointFiles, loginFiles, modelFiles } from './lib/config.ts';
import { sanitizeHarnessEnv } from './lib/shared/harness-env.ts';
import type { HarnessKind } from './lib/shared/harness.ts';

/** A harness's wrapper is a program the manifest declared in `permissions.spawn`; the kernel resolves the name. */
const PROGRAMS: Readonly<Record<HarnessKind, string>> = { claude: 'claude', codex: 'codex' };

/**
 * The owned login stores live in the kernel's `credentials` internal root (§7.7), declared in the manifest and given
 * to Logins alone: its base is `<home>/state/logins/credentials`, and a linked, foreign or missing base is refused on
 * every call. Nothing here, in config, a route or a caller names that folder.
 */
export function buildLoginsDaemon() {
  return implementDaemon(manifest, {
    build({ needs, uses, kernel }) {
      const { clock, config, events, jobs, lifecycle, log, state } = kernel;
      const files = () => loginFiles(config);

      // ── presets and model catalogs: data, with this machine's own files over the built-ins ──────────────────────
      const machinePresets = async (): Promise<Readonly<Record<string, ProviderPreset>>> =>
        Object.fromEntries(
          [...endpointFiles(config).entries()].map(([id, file]) => [
            id,
            presetFromFile(id, file as ProviderPresetFile, 'file'),
          ]),
        );
      const presetService: ProviderPresetService = new ProviderPresetService(
        { presets: machinePresets },
        undefined,
        () => catalogs.catalogs(),
      );
      const catalogs: ModelCatalogService = new ModelCatalogService({
        files: async () => {
          const out: Record<string, import('./lib/catalog/schema.ts').ModelCatalog> = {};
          for (const [id, file] of modelFiles(config)) {
            const parsed = parseModelCatalog(id, file, 'file');
            if (parsed.ok) out[id] = parsed.value;
          }
          return out;
        },
        published: async () => {
          published.refreshIfDue();
          return await published.catalogs();
        },
        presets: () => presetService.presets(),
        ollama: () => localModels.snapshot(),
      });

      const origin = HOSTED_APP_ORIGIN;
      const published = new PublishedModelCatalogService({
        fetch: new HostedModelCatalog(origin, kernel.fetch, clock),
        cache: new StateModelCatalogCache(state),
        publicKeyPem: HOSTED_APP_RELEASE_KEY,
        nowMs: () => clock.nowMs(),
        onUpdated: async () => {
          events.publish(ModelsChanged, {});
        },
      });

      // ── providers: every authorized read goes through the Vault, which holds the key and never returns it ───────
      const probe = new AuthorizedProviderProbe(needs.vault, new BoundedTransport(kernel.fetch, clock));
      const localModels = new LocalModelsService({
        probe,
        address: undefined,
        enabled: true,
        suggested: async () => suggestedOllamaModel(await catalogs.catalogs()),
        now: () => clock.now(),
        onChanged: async () => {
          events.publish(ModelsChanged, {});
        },
      });
      const providerProbe = new ProviderProbeService({
        probe,
        clock: { monotonicMs: () => clock.nowMs(), now: () => clock.now() },
      });

      // ── logins ──────────────────────────────────────────────────────────────────────────────────────────────────────
      const store = new OwnedLoginStore(kernel.roots.root('credentials'), () => clock.nowMs());
      const catalog = store.catalog(files);
      const quota = quotaFetch(kernel.fetch, clock);
      const status = new CredentialStatusService(
        store.statusPorts({
          anthropic: new AnthropicUsageProbe({ fetch: quota }),
          codex: new CodexUsageProbe({ fetch: quota, now: () => clock.nowMs() }),
          refresh: codexTokenRefresh(kernel.spawn, clock),
          usageIntervalMs: 60_000,
        }),
      );
      const credentials = new FleetCredentialsService({
        catalog,
        status,
        email: async source => await store.email(source),
        machineName: () => 'this machine',
        locate: harness => PROGRAMS[harness],
        run: async spec => {
          const [program, ...args] = spec.command as [string, ...string[]];
          const env: Record<string, string> = {};
          for (const [name, value] of Object.entries(spec.environment)) if (value !== undefined) env[name] = value;
          return (await kernel.spawn.run(program, args, { env })).exitCode ?? 1;
        },
        baseEnvironment: () => sanitizeHarnessEnv({}),
        environment: {
          catalog: () => presetService.catalog(),
          presets: () => presetService.presets(),
          secretNames: async () => new Set((await needs.vault.names()).map(summary => String(summary.name))),
          test: (subject, consent) => providerProbe.test(subject, consent),
        },
        listCache: { now: () => clock.nowMs(), freshMs: CREDENTIAL_LIST_FRESH_MS },
      });

      const harnessLogin = new HarnessLoginService({
        credentialTargets: { target: async id => catalog.signInTarget(await catalog.entry(id)) },
        locate: harness => PROGRAMS[harness],
        clock: { now: () => clock.nowMs() },
        mintId: () => String(kernel.ids.mint('signin')),
        spawn: spawnHarnessLoginChild(kernel.spawn),
        deliverCallback: deliverCodexCallback(kernel.fetch, clock),
        environment: sanitizeHarnessEnv({}),
        timer: harnessLoginTimer(clock),
        // Browsers owns machine.browserPorts (decision 19). Only an explicit non-shared fact enables automatic
        // localhost fallback; no provider, no method, or a failed read all retain the shared-host refusal.
        sharedHost: async () => {
          try {
            return (await uses.browsers.current()?.browserPorts?.())?.shared !== false;
          } catch {
            return true;
          }
        },
        portHolders: systemPortHolders(kernel.spawn, clock),
        clientName: 'ferretry',
        onSignedIn: loginId => {
          events.publish(LoginSignedIn, { loginId: loginId as LoginId });
          events.publish(LoginChanged, { loginId: loginId as LoginId, change: 'status' });
        },
      });
      lifecycle.onStop(async () => {
        await harnessLogin.shutdown();
      });

      // The models are read once after start (never on a timer): a published catalog and the local server.
      jobs.add({
        id: 'logins.models-refresh',
        schedule: { onceAfterStart: true, delay: milliseconds(1_000) },
        run: async () => {
          await published.refresh(false).catch(error => {
            log.warn('the published model catalog could not be checked', {
              reason: error instanceof Error ? error.message : 'unknown',
            });
          });
          await localModels.refresh();
        },
      });

      const publishedState = (held: Awaited<ReturnType<typeof published.status>>): PublishedCatalogState => ({
        origin,
        enabled: published.enabled,
        ...(held.version === undefined ? {} : { version: held.version }),
        ...(held.fetchedAt === undefined ? {} : { fetchedAt: held.fetchedAt as Instant }),
        ...(held.checkedAt === undefined ? {} : { checkedAt: held.checkedAt as Instant }),
        ...(held.last === undefined ? {} : { last: held.last }),
      });
      const modelsView = async () =>
        modelCatalogsView(await catalogs.catalogs(), publishedState(await published.status()));

      const api: Omit<LoginsApi, 'authorizeFetch'> = {
        list: () => credentials.list(),
        get: async id => (await credentials.list()).logins.find(login => login.id === id),
        quota: async id => (await credentials.list()).logins.find(login => login.id === id)?.usage,
        presets: () => credentials.presets(),
        models: modelsView,
        // The routes and this port share ONE service below, so a change staged either way has the same refusals, the
        // same held review and the same events. `changes` is built after `api` (it reads `api.get`); these call it lazily.
        changes: { stage: change => changes.stage(change), apply: id => changes.apply(id) },
      };

      /**
       * THE PORT EACH PLUGIN IS HANDED (§3.7), built once per needing plugin by the kernel. Every read is shared; the one call
       * that spends a key is held to the CALLER's own manifest network as well as to the login's own hosts, so a piece that
       * declares no host (Runtimes) reaches none, and Usage reaches only the hosts it declares.
       *
       * A login's key on ONE request (Usage's quota read): the secret is read from the login's OWN record, never from the
       * caller, and so is the host: the allowance is {@link spendHostsOf} (today's keyed Test rule), and a host the caller
       * names outside it is dropped. The Vault then holds this plugin to the secrets it declares or an owner-written record
       * names, and to its own network. Everything the caller passed is copied ONCE here and only the copy is used.
       */
      const apiFor = (needer: Needer): LoginsApi => ({
        ...api,
        authorizeFetch: async (loginId, variable, hostAllowlist, request, placement) => {
          const id = String(loginId);
          const key = String(variable);
          const named = [...hostAllowlist].map(String);
          // Parsed ONCE into plain data (S162): the request the Vault is handed is this copy, never the caller's object.
          const asked = OutboundHttpRequestSchema.safeParse(request);
          const placed = placement === undefined ? undefined : CredentialPlacementSchema.safeParse(placement);
          if (!asked.success || (placed !== undefined && !placed.success)) return { kind: 'refused' };
          const login = (await credentials.list()).logins.find(candidate => candidate.id === id);
          const name = spendSecretOf(login, key);
          if (name === undefined) return { kind: 'refused' };
          const hosts = spendableHosts(spendHostsOf(login, await credentials.presets()), named, hostname =>
            neederMayReach(needer, hostname),
          );
          if (hosts.length === 0) return { kind: 'refused' };
          return await needs.vault.authorizeFetch(name, hosts, asked.data, placed?.data);
        },
      });

      // Logins OWNS its change routes: add, sign out, disable, enable, label, remove. A change edits this plugin's own
      // `config/logins/<id>.yaml` through the kernel's config write port, so the one writer's rules hold (a raw secret
      // refused, the last good version kept, a loosening held for the owner).
      const changes = new LoginChangeService({
        files,
        presets: async () => Object.values(await presetService.presets()),
        machineName: () => 'this machine',
        view: id => api.get(id as LoginId),
        signOut: id => credentials.signOut(id),
        write: (id, patch) => config.write(LOGINS_CONFIG, id, { patch }),
        remove: id => config.remove(LOGINS_CONFIG, id),
        changed: (loginId, change) => {
          events.publish(LoginChanged, { loginId: loginId as LoginId, change });
        },
        now: () => clock.nowMs(),
        mintId: () => String(kernel.ids.mint('change')),
      });

      const kinds = loginKinds({
        clock,
        files,
        view: id => api.get(id as LoginId),
        // The hook is Ferrets' trusted launch path (decision 19). Person operations stay on admitted Logins
        // routes; the private orchestration grants no caller standing and is not exported through LoginsApi.
        check: id => credentials.checkForLaunch(id),
        startSignIn: id => harnessLogin.startForLaunch({ loginId: id as LoginId }),
        signInStatus: flowId => harnessLogin.status(flowId),
      });

      return {
        routes: {
          ...signInRoutes(harnessLogin),
          ...loginRoutes(credentials),
          ...changeRoutes(changes),
          ...modelRoutes({
            view: modelsView,
            refresh: () => published.refresh(true),
            refreshLocal: () => localModels.refresh(),
          }),
        },
        provides: { logins: perNeeder(apiFor) },
        hooks: {
          'logins:anthropic': kinds.anthropic,
          'logins:openai': kinds.openai,
          'logins:api-key': kinds['api-key'],
          'logins:proxy': kinds.proxy,
          'logins:endpoint': kinds.endpoint,
        },
      };
    },
  });
}

export default buildLoginsDaemon();
