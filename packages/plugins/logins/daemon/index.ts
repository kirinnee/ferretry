/**
 * Logins' daemon half (§2.3): the AI provider sign-ins, API keys, proxies and endpoints ferrets spend.
 *
 * `build` wires the services this plugin owns — the harness sign-in flows, the logins list with Check now and Test, the
 * provider presets, the model catalogs and the local-models read — over the kernel's ports, and hands back the eleven
 * routes, the `logins` read model and the five `logins:*` kinds. Nothing here holds a token: a harness writes its own
 * sign-in into its own store, and an environment login names its secrets as `${secret:NAME}` in a file.
 */
import { implementDaemon } from '@ferretry/kernel/manifest';
import { type Instant, milliseconds } from '@ferretry/std';
import manifest from '../manifest.ts';
import { type LoginId, type LoginsApi, LoginChanged, LoginSignedIn, ModelsChanged } from '../contract/index.ts';
import { HostedModelCatalog, StateModelCatalogCache } from './adapters/models/index.ts';
import { AuthorizedProviderProbe, BoundedTransport } from './adapters/provider-probe/index.ts';
import { deliverCodexCallback } from './adapters/harness-login/callback-delivery.ts';
import { harnessLoginTimer, spawnHarnessLoginChild } from './adapters/harness-login/login-child.ts';
import { systemPortHolders } from './adapters/harness-login/port-holders.ts';
import { parseModelCatalog } from './lib/catalog/catalog.ts';
import { suggestedOllamaModel } from './lib/local-models/ollama.ts';
import { LocalModelsService } from './lib/local-models/service.ts';
import {
  CREDENTIAL_LIST_FRESH_MS,
  FleetCredentialCatalog,
  FleetCredentialsService,
} from './lib/credentials/credentials-service.ts';
import { CredentialStatusService } from './lib/credentials/credential-status.ts';
import { unreadableStatusPorts, UNOPENABLE_INSPECTION } from './lib/credentials/store-ports.ts';
import { HarnessLoginService } from './lib/harness-login/service.ts';
import { loginKinds } from './lib/kinds.ts';
import { ModelCatalogService } from './lib/models/service.ts';
import { PublishedModelCatalogService } from './lib/models/published.ts';
import { modelCatalogsView, type PublishedCatalogState } from './lib/models/view.ts';
import { presetFromFile, type ProviderPreset, type ProviderPresetFile } from './lib/presets/schema.ts';
import { ProviderPresetService } from './lib/provider-probe/presets.ts';
import { ProviderProbeService } from './lib/provider-probe/service.ts';
import { loginRoutes } from './lib/routes/logins.ts';
import { modelRoutes } from './lib/routes/models.ts';
import { signInRoutes } from './lib/routes/sign-in.ts';
import { HOSTED_APP_ORIGIN, HOSTED_APP_RELEASE_KEY } from './lib/shared/hosted.ts';
import { endpointFiles, loginFiles, modelFiles } from './lib/config.ts';
import { sanitizeHarnessEnv } from './lib/shared/harness-env.ts';
import type { HarnessKind } from './lib/shared/harness.ts';

/** A harness's wrapper is a program the manifest declared in `permissions.spawn`; the kernel resolves the name. */
const PROGRAMS: Readonly<Record<HarnessKind, string>> = { claude: 'claude', codex: 'codex' };

export default implementDaemon(manifest, {
  build({ needs, kernel }) {
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
    const presetService: ProviderPresetService = new ProviderPresetService({ presets: machinePresets }, undefined, () =>
      catalogs.catalogs(),
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
    const catalog = new FleetCredentialCatalog({
      logins: files,
      paths: undefined,
      inspect: async () => UNOPENABLE_INSPECTION,
      ensureDirectory: async () => undefined,
    });
    const status = new CredentialStatusService(unreadableStatusPorts(() => clock.nowMs(), 60_000));
    const credentials = new FleetCredentialsService({
      catalog,
      status,
      email: async () => undefined,
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
      sharedHost: async () => false,
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

    const api: LoginsApi = {
      list: () => credentials.list(),
      get: async id => (await credentials.list()).logins.find(login => login.id === id),
      quota: async id => (await credentials.list()).logins.find(login => login.id === id)?.usage,
      presets: () => credentials.presets(),
      models: modelsView,
    };

    const kinds = loginKinds({
      clock,
      files,
      view: id => api.get(id as LoginId),
      check: id => credentials.check(id, undefined),
      startSignIn: id => harnessLogin.start({ loginId: id as LoginId }, undefined),
      signInStatus: flowId => harnessLogin.status(flowId),
    });

    return {
      routes: {
        ...signInRoutes(harnessLogin),
        ...loginRoutes(credentials),
        ...modelRoutes({
          view: modelsView,
          refresh: () => published.refresh(true),
          refreshLocal: () => localModels.refresh(),
        }),
      },
      provides: { logins: api },
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
