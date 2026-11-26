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
  type LoginChangesApi,
  type LoginId,
  type LoginsApi,
  LOGIN_ENV_IMPORT_NEEDER,
  LOGINS_CONFIG,
  LoginChanged,
  LoginsBudget,
  LoginsQuota,
  LoginsUsedBy,
  LoginSignedIn,
  ModelsChanged,
} from '../contract/index.ts';
import { HostedModelCatalog, StateModelCatalogCache, StateModelListStore } from './adapters/models/index.ts';
import { spendHostsOf, spendableHosts, spendSecretOf } from './lib/credentials/spend-secret.ts';
import { AuthorizedProviderProbe, BoundedTransport } from './adapters/provider-probe/index.ts';
import { deliverCodexCallback } from './adapters/harness-login/callback-delivery.ts';
import { harnessLoginTimer, spawnHarnessLoginChild } from './adapters/harness-login/login-child.ts';
import { systemPortHolders } from './adapters/harness-login/port-holders.ts';
import { OwnedLoginStore } from './adapters/credentials/owned-store.ts';
import { StatePassiveAssignments } from './adapters/credentials/state-passive-assignments.ts';
import { codexCredentialSource } from './adapters/credentials/codex-credential.ts';
import { AnthropicUsageProbe, quotaFetch } from './adapters/credentials/anthropic-usage-probe.ts';
import { CodexUsageProbe } from './adapters/credentials/codex-usage-probe.ts';
import { HOUSEKEEPING_WORKER_URL, housekeepingClient } from './adapters/credentials/housekeeping-client.ts';
import { codexTokenRefresh } from './adapters/credentials/token-refresh.ts';
import { parseModelCatalog } from './lib/catalog/catalog.ts';
import { suggestedOllamaModel } from './lib/local-models/ollama.ts';
import { LocalModelsService } from './lib/local-models/service.ts';
import { CREDENTIAL_LIST_FRESH_MS, FleetCredentialsService } from './lib/credentials/credentials-service.ts';
import { CredentialStatusService } from './lib/credentials/credential-status.ts';
import { CodexPassiveReading } from './lib/credentials/passive-codex.ts';
import { HarnessLoginService } from './lib/harness-login/service.ts';
import { loginKinds } from './lib/kinds.ts';
import { environmentTemplates } from './lib/profile-templates.ts';
import { ModelCatalogService } from './lib/models/service.ts';
import { PublishedModelCatalogService } from './lib/models/published.ts';
import { modelCatalogsView, type PublishedCatalogState } from './lib/models/view.ts';
import { modelPriceCatalogs } from './lib/models/prices.ts';
import { modelCatalogSourcesView } from './lib/models/sources.ts';
import { presetFromFile, type ProviderPreset, type ProviderPresetFile } from './lib/presets/schema.ts';
import { ProviderPresetService } from './lib/provider-probe/presets.ts';
import { ProviderProbeService } from './lib/provider-probe/service.ts';
import { LoginEnvImport, refusedEnvImport } from './features/host-import/env-import.ts';
import { loginChangesPort } from './lib/changes/port.ts';
import { LoginChangeService } from './lib/changes/service.ts';
import { changeRoutes } from './lib/routes/changes.ts';
import { loginRoutes } from './lib/routes/logins.ts';
import { modelRoutes } from './lib/routes/models.ts';
import { modelListRoutes } from './lib/routes/model-lists.ts';
import { modelListReadDraft } from './lib/model-lists/audit.ts';
import { ModelListService } from './lib/model-lists/service.ts';
import { signInRoutes } from './lib/routes/sign-in.ts';
import { HOSTED_APP_ORIGIN, HOSTED_APP_RELEASE_KEY } from './lib/shared/hosted.ts';
import { endpointFiles, loginFiles, modelFiles } from './lib/config.ts';
import { sanitizeHarnessEnv } from './lib/shared/harness-env.ts';
import { type HarnessKind, isKind, supportedKindOfKey } from './lib/shared/harness.ts';
import { credentialHarnessKeys } from './lib/shared/halves.ts';

/** How often the Codex passive reading looks for a rollout that moved: an unchanged one costs a stat. */
const CODEX_PASSIVE_USAGE_INTERVAL_MS = 30_000;
/** The kernel job that runs it. */
export const CODEX_PASSIVE_USAGE_JOB = 'logins.codex-passive-usage';

/** A harness's wrapper is a program the manifest declared in `permissions.spawn`; the kernel resolves the name. */
const PROGRAMS: Readonly<Record<HarnessKind, string>> = { claude: 'claude', codex: 'codex' };

/**
 * The owned login stores live in the kernel's `credentials` internal root (§7.7), declared in the manifest and given
 * to Logins alone: its base is `<home>/state/logins/credentials`, and a linked, foreign or missing base is refused on
 * every call. Nothing here, in config, a route or a caller names that folder.
 */
export function buildLoginsDaemon() {
  return implementDaemon(manifest, {
    // The sign-in read's thread: `fyd --check` starts and stops it, so a binary that did not carry it is seen at once.
    workers: { housekeeping: HOUSEKEEPING_WORKER_URL },
    build({ needs, uses, kernel, hooks }) {
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
        modelListRecorder: loginId => modelLists.recorder(loginId),
        // Each keyed list read puts the login's key on a request: the Vault does not write `secrets.used` for that, so the
        // read does (the secret's name, the host and the outcome's kind; docs/audit.md).
        onListRead: async note => {
          await needs.gate.audit(modelListReadDraft(note));
        },
      });
      // Each login's live model list: read when somebody's act causes it (Add login, Test, a picker open past a day,
      // "Refresh list"), never on a timer. Ids only, in `state/logins/model-lists/`.
      const modelLists: ModelListService = new ModelListService({
        store: new StateModelListStore(state),
        now: () => clock.now(),
        nowMs: () => clock.nowMs(),
        // The login's file as it is in effect: an edit of its key or address is a different revision, and a removal is none.
        revision: id => {
          const file = files().get(id);
          return file === undefined ? undefined : JSON.stringify(file);
        },
        read: async id => {
          const entry = await catalog.entry(id).catch(() => undefined);
          if (entry === undefined) return undefined;
          const preset =
            entry.credential.preset === undefined
              ? undefined
              : (await presetService.presets()).find(candidate => candidate.id === entry.credential.preset);
          const answer = await providerProbe.listModels({ id, credential: entry.credential, preset });
          if (answer === undefined) return undefined;
          return answer === 'failed' ? { kind: 'none' } : { kind: 'listed', payload: answer.payload };
        },
        onChanged: async () => {
          events.publish(ModelsChanged, {});
        },
      });

      // ── logins ──────────────────────────────────────────────────────────────────────────────────────────────────────
      const store = new OwnedLoginStore(kernel.roots.root('credentials'), () => clock.nowMs());
      // Which runtimes launch on a login is Runtimes' to say; the list only DISPLAYS it, so no provider (Runtimes off) or
      // one that cannot answer reads as none rather than failing the whole list (a removal asks again and fails closed).
      const catalog = store.catalog(files, async id => {
        const users = hooks.provider(LoginsUsedBy, 'runtimes');
        if (users === 'unavailable') return [];
        try {
          return await users.of(id);
        } catch {
          return [];
        }
      });
      const quota = quotaFetch(kernel.fetch, clock);
      // The free usage read happens on the housekeeping worker, which reads the sign-in itself (read-only grant).
      const housekeeping = housekeepingClient({ workers: kernel.workers, clock });
      lifecycle.onStop(() => housekeeping.stop());
      const vaultNames = async (): Promise<ReadonlySet<string>> =>
        new Set((await needs.vault.names()).map(summary => String(summary.name)));
      const status = new CredentialStatusService(
        store.statusPorts({
          anthropic: new AnthropicUsageProbe({ fetch: quota }),
          codex: new CodexUsageProbe({ fetch: quota, now: () => clock.nowMs() }),
          activeUsage: async resolution =>
            await housekeeping.activeUsage(resolution.harness, store.signInFile(resolution)),
          refresh: codexTokenRefresh(kernel.spawn, clock),
          usageIntervalMs: 60_000,
          secretNames: vaultNames,
        }),
      );
      const credentials = new FleetCredentialsService({
        catalog,
        status,
        email: async source => await store.email(source),
        organizationType: async source => await store.organizationType(source),
        machineName: () => 'this machine',
        locate: harness => PROGRAMS[harness],
        run: async spec => {
          const [program, ...args] = spec.command as [string, ...string[]];
          const env: Record<string, string> = {};
          for (const [name, value] of Object.entries(spec.environment)) if (value !== undefined) env[name] = value;
          const ended = await kernel.spawn.run(program, args, { env });
          return ended.exitCode ?? ended.signal ?? 'a signal';
        },
        baseEnvironment: () => sanitizeHarnessEnv({}),
        environment: {
          catalog: () => presetService.catalog(),
          presets: () => presetService.presets(),
          secretNames: vaultNames,
          test: (subject, consent) => providerProbe.test(subject, consent),
        },
        listCache: { now: () => clock.nowMs(), freshMs: CREDENTIAL_LIST_FRESH_MS },
        // What a row's "Used by" shows is what Runtimes lists (files plus derived); no provider keeps the files' answer.
        shownUsers: async logins => {
          const users = hooks.provider(LoginsUsedBy, 'runtimes');
          if (users === 'unavailable' || users.listed === undefined) throw new Error('nothing lists the runtimes');
          return await users.listed(logins);
        },
        // Usage reads the provider quotas: an environment login's last reading rides on its row (none when it is off).
        providerQuota: {
          peek: id => {
            const quotas = hooks.provider(LoginsQuota, 'usage');
            return quotas === 'unavailable' ? undefined : quotas.peek(id);
          },
        },
        // Usage owns the budgets and meters the spend: the standing shown is the one it measures (none when it is off).
        budget: {
          view: id => {
            const budgets = hooks.provider(LoginsBudget, 'usage');
            return budgets === 'unavailable' ? undefined : budgets.view(id);
          },
        },
      });

      // The Codex logins' usage stays fresh from the rollouts of the ferrets launched on them (§8.2.3): one pass on an
      // interval, over the transcripts Ferrets' harness proved to be those ferrets' own. Ferrets off reads as no ferrets.
      const codexPassive = new CodexPassiveReading({
        logins: async () =>
          (await catalog.entries()).entries.flatMap(entry =>
            isKind(entry.credential.harness, 'codex')
              ? [{ subject: { id: entry.id, resolution: entry.resolution }, usedBy: entry.usedBy }]
              : [],
          ),
        sessions: async () => {
          const ferrets = uses.ferrets.current();
          if (ferrets === undefined) return [];
          return (await ferrets.list()).flatMap(ferret =>
            isKind(ferret.harness, 'codex') && ferret.state !== 'stopped'
              ? [
                  {
                    id: ferret.id,
                    ...(ferret.runtime === undefined ? {} : { runtime: ferret.runtime }),
                    ...(ferret.login === undefined ? {} : { login: ferret.login }),
                    // Only where its login's `since` is first taken from; Logins keeps that record itself.
                    stateAt: Date.parse(ferret.stateAt),
                    // The ferret as it is now, asked again once its transcript was read (a move may have come between).
                    current: async () => {
                      const now = await ferrets.get(ferret.id);
                      return now === undefined || !isKind(now.harness, 'codex') || now.state === 'stopped'
                        ? undefined
                        : {
                            ...(now.runtime === undefined ? {} : { runtime: now.runtime }),
                            ...(now.login === undefined ? {} : { login: now.login }),
                          };
                    },
                    open: async () => await (await ferrets.harness?.(ferret.id))?.transcriptBytes?.(),
                  },
                ]
              : [],
          );
        },
        assignments: new StatePassiveAssignments(state),
        now: () => clock.nowMs(),
        write: (subject, record) => store.recordPassiveUsage(subject, record),
      });
      jobs.add({
        id: CODEX_PASSIVE_USAGE_JOB,
        schedule: { every: milliseconds(CODEX_PASSIVE_USAGE_INTERVAL_MS) },
        lane: 'worker',
        run: async () => {
          await codexPassive.pass();
        },
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
        // The binary the person types (fy, or the name the operator gave it), never the product name.
        clientName: kernel.identity.binaries.client,
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
        launchRefusal: async (id, harness) => {
          const file = files().get(id);
          if (supportedKindOfKey(harness) !== undefined) return undefined;
          if (harness !== 'opencode') {
            const kind = file === undefined ? undefined : supportedKindOfKey(file.harness);
            return file !== undefined &&
              kind !== undefined &&
              credentialHarnessKeys({ ...file, harness: kind }).includes(harness)
              ? undefined
              : `Login ${id} cannot be spent by ${harness}`;
          }
          if (file === undefined) return 'Choose an API-key or endpoint login for OpenCode';
          return file.store === 'environment'
            ? undefined
            : 'OpenCode refuses subscription sign-ins, including Anthropic Claude subscriptions; choose an API key or endpoint login';
        },
        list: () => credentials.list(),
        // Read live from each login's own file, kept nowhere: Runtimes asks on every read of its model.
        environmentTemplates: async () =>
          environmentTemplates(files(), id => config.fileState(LOGINS_CONFIG, id).state),
        // The stores a person-run wrapper signs in through: the one projection a ferret's launch also uses.
        launchStores: () => credentials.launchStores(),
        get: async id => (await credentials.list()).logins.find(login => login.id === id),
        quota: async id => (await credentials.list()).logins.find(login => login.id === id)?.usage,
        presets: () => credentials.presets(),
        models: modelsView,
        modelPrices: async () => modelPriceCatalogs(await catalogs.catalogs()),
        modelSources: async () => modelCatalogSourcesView(await catalogs.sources()),
        modelLists: () => modelLists.all(),
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

      // The routes and this port share ONE service below, so a change staged either way has the same refusals, the
      // same held review and the same events. `changes` is built after `api` (it reads `api.get`); these call it lazily.
      const changesApi: LoginChangesApi = loginChangesPort({
        stage: (change, options) => changes.stage(change, options),
        apply: (id, door) => changes.apply(id, door),
        discard: id => changes.discard(id),
      });

      // The setup import's door (r9 A8): the PERSON's write (a reference to a secret goes into effect only for the owner, and is otherwise
      // held for them, as for any other editor), pinned to the disk etag read first so it never replaces what moved.
      const envImport = new LoginEnvImport({
        files,
        look: async id => ({
          etag: await config.etag(LOGINS_CONFIG, id),
          state: config.fileState(LOGINS_CONFIG, id).state,
        }),
        write: (id, patch, ifMatch) => config.writeAsCaller(LOGINS_CONFIG, id, { patch }, { ifMatch }),
      });

      // Logins OWNS its change routes: add, sign out, disable, enable, label, remove. A change edits this plugin's own
      // `config/logins/<id>.yaml` through the kernel's config write port, so the one writer's rules hold (a raw secret
      // refused, the last good version kept, a loosening held for the owner).
      const changes = new LoginChangeService({
        files,
        presets: async () => Object.values(await presetService.presets()),
        machineName: () => 'this machine',
        // Which runtimes use a login is Runtimes' to say. No provider (Runtimes off) is an answer too: unknown, and a
        // removal fails closed on it.
        usedBy: async id => {
          const users = hooks.provider(LoginsUsedBy, 'runtimes');
          if (users === 'unavailable') throw new Error('nothing answers which runtimes use a login');
          return await users.of(id);
        },
        runtimesAfter: async change => {
          const users = hooks.provider(LoginsUsedBy, 'runtimes');
          return users === 'unavailable' ? undefined : await users.after?.(change);
        },
        view: id => api.get(id as LoginId),
        signOut: id => credentials.signOut(id),
        // The owner's reviewed change: made to both versions of a login with an edit held, so it never puts another
        // caller's held edit (a raised budget) into effect.
        write: (id, patch) => config.writeAsOwner(LOGINS_CONFIG, id, { patch }),
        // A removal that the kernel would hold is refused instead: a held removal would leave the login in effect and be
        // put through later by a path that does not ask what uses it.
        remove: id => config.remove(LOGINS_CONFIG, id, { refuseIfHeld: true }),
        changed: (loginId, change) => {
          events.publish(LoginChanged, { loginId: loginId as LoginId, change });
        },
        now: () => clock.nowMs(),
        mintId: () => String(kernel.ids.mint('change')),
      });

      // The files are the source of truth (docs/config-files.md): a login file that moved in effect by ANY editor — a
      // hand edit, `fy config`, an agent's config tool, or this plugin's own changes — is announced, so whoever reads
      // the logins (the views, Runtimes' disable-until timer) reads them again. A change made through the changes
      // service is announced by it too; a second word for the same move is one more read, never a wrong one.
      let inEffect = files();
      const unwatchFiles = config.watch(LOGINS_CONFIG, () => {
        const next = files();
        for (const id of new Set([...inEffect.keys(), ...next.keys()])) {
          const before = inEffect.get(id);
          const after = next.get(id);
          if (JSON.stringify(before) === JSON.stringify(after)) continue;
          const change = before === undefined ? 'added' : after === undefined ? 'removed' : 'edited';
          events.publish(LoginChanged, { loginId: id as LoginId, change });
          // Add login (and an edit that may have moved its address or key) reads the provider's model list once; a removed
          // login's list goes with it. A refresh never throws and a provider that is down keeps the last list.
          if (change === 'removed') void modelLists.forget(id);
          else void modelLists.refresh(id, { force: true });
        }
        inEffect = next;
      });
      lifecycle.onStop(() => {
        unwatchFiles();
      });

      const codexCredential = codexCredentialSource({ catalog, store, roots: kernel.roots });
      const kinds = loginKinds({
        clock,
        files,
        view: id => api.get(id as LoginId),
        // The hook is Ferrets' trusted launch path (decision 19). Person operations stay on admitted Logins
        // routes; the private orchestration grants no caller standing and is not exported through LoginsApi.
        check: id => credentials.checkForLaunch(id),
        launchStore: id => credentials.launchStore(id),
        startSignIn: id => harnessLogin.startForLaunch({ loginId: id as LoginId }),
        signInStatus: flowId => harnessLogin.status(flowId),
        credentialProblem: id => codexCredential.problem(id),
        shareCredential: id => codexCredential.share(id),
      });

      return {
        routes: {
          ...signInRoutes(harnessLogin),
          ...loginRoutes(credentials, async () => {
            // Somebody is reading the list: the quotas that are due are read first, so the row shows them now.
            const quotas = hooks.provider(LoginsQuota, 'usage');
            if (quotas !== 'unavailable') await quotas.watch().catch(() => undefined);
          }),
          ...changeRoutes(changes),
          ...modelListRoutes({
            refresh: async (id, options) => {
              await catalog.entry(id); // a login this machine does not have is a 404
              return await modelLists.refresh(id, options);
            },
          }),
          ...modelRoutes({
            view: modelsView,
            refresh: () => published.refresh(true),
            refreshLocal: () => localModels.refresh(),
          }),
        },
        provides: {
          logins: perNeeder(apiFor),
          loginChanges: changesApi,
          // The setup import adds a harness's own `env` to the login its apply selected (r9 A8). Only Runtimes is handed a working door;
          // every other needer gets a port that refuses.
          loginEnvImport: perNeeder(needer => (needer.id === LOGIN_ENV_IMPORT_NEEDER ? envImport : refusedEnvImport)),
        },
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
