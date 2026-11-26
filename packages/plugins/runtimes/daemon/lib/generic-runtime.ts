import { randomUUID } from 'node:crypto';
import {
  ApiError,
  type HookDecision,
  type ConfigCollectionDef,
  type ConfigFileDef,
  type ConfigWriteAllDocument,
  type KernelPorts,
} from '@ferretry/kernel/contract';
import type {
  FerretsApi,
  HarnessRuntimeDescriptor,
  HarnessRuntimeModels,
  RuntimeStartSource,
  StartDecideInput,
} from '@ferretry/core-ferrets/contract';
import { LoginIdSchema, type LoginsApi } from '@ferretry/plugin-logins/contract';
import { instantFromEpochMs, minutes } from '@ferretry/std';
import {
  RUNTIME_ITEMS,
  PROFILE_ITEMS,
  MODEL_SET_ITEMS,
  RUNTIMES_CONFIG,
  RuntimesChanged,
  type AccountChange,
  type AccountChangeView,
  type RuntimeFile,
  type RuntimeView,
  type RuntimeSummary,
  type RuntimeId,
  type RuntimeLayersApi,
  type RuntimesFile,
  type ProfileFile,
  type ModelSetFile,
  type ToolInstallOutcome,
} from '../../contract/index.ts';
import type { RuntimesAssembly } from '../index.ts';
import { supportedKindOfKey } from './harness-kind.ts';
import { createRuntimesApi } from './service/runtimes-api.ts';
import { FleetProposalStore, type FleetProposalRecord } from './service/proposals.ts';
import { assertRequestLive } from './service/apply-bracket.ts';

type RuntimeApi = ReturnType<typeof createRuntimesApi>;
type NativeChange = Extract<AccountChange, { kind: 'runtime.put' | 'runtime.remove' }>;
interface Staged {
  readonly documents: readonly ConfigWriteAllDocument[];
  readonly dependencies: readonly {
    readonly def: ConfigCollectionDef<any>;
    readonly name: string;
    readonly etag: string;
  }[];
}
interface Registered {
  readonly key: string;
  readonly label: string;
  readonly runtime: HarnessRuntimeDescriptor;
}
interface Reading {
  readonly summary: RuntimeSummary;
  readonly view: RuntimeView;
  readonly models: HarnessRuntimeModels;
}
const unsupported = (label: string): never => {
  throw new ApiError(409, `${label}: not supported by Ferretry yet`, 'runtime_unsupported');
};
const refused = (sentence: string): never => {
  throw new ApiError(409, sentence, 'runtime_refused');
};
const runtimeItems = RUNTIME_ITEMS as unknown as ConfigCollectionDef<RuntimeFile>;
const profileItems = PROFILE_ITEMS as unknown as ConfigCollectionDef<ProfileFile>;
const modelSetItems = MODEL_SET_ITEMS as unknown as ConfigCollectionDef<ModelSetFile>;
const runtimesConfig = RUNTIMES_CONFIG as unknown as ConfigFileDef<RuntimesFile>;
function overlay<T extends object>(base: T, overrides: Partial<T>): T {
  return new Proxy(base, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return Reflect.get(overrides, property);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** One opt-in path for every registered harness outside the legacy account model. */
export class GenericRuntimes {
  readonly #changes: FleetProposalStore<Staged, NativeChange>;
  constructor(
    private readonly deps: {
      readonly kernel: KernelPorts;
      readonly ferrets: Pick<FerretsApi, 'harnesses' | 'harnessFacts' | 'harnessRuntime'>;
      readonly logins: Pick<LoginsApi, 'list' | 'get' | 'launchRefusal'>;
    },
  ) {
    this.#changes = new FleetProposalStore({
      now: () => deps.kernel.clock.nowMs(),
      mintId: () => randomUUID().replaceAll('-', '').slice(0, 22),
    });
  }

  private registered(key: string): Registered | undefined {
    if (supportedKindOfKey(key) !== undefined || !this.deps.ferrets.harnesses().includes(key)) return undefined;
    const runtime = this.deps.ferrets.harnessRuntime?.(key);
    const facts = this.deps.ferrets.harnessFacts(key);
    return runtime === undefined || facts === undefined ? undefined : { key, label: facts.displayName, runtime };
  }
  private registrations(): readonly Registered[] {
    return this.deps.ferrets.harnesses().flatMap(key => this.registered(key) ?? []);
  }
  private async detect(item: Registered) {
    try {
      return await item.runtime.detect();
    } catch {
      return refused(`${item.label} could not report its installation`);
    }
  }
  /** Native-only files never enter the legacy account-model validator or provisioner. Shared legacy profiles stay. */
  accountKernel(): KernelPorts {
    const original = this.deps.kernel;
    return {
      ...original,
      config: overlay(original.config, {
        collection: ((def: ConfigCollectionDef<unknown>) => {
          const held = original.config.collection(def);
          if (Object.is(def, runtimeItems))
            return new Map(
              [...held].filter(([, value]) => {
                const file = value as RuntimeFile;
                return file.harness === undefined || this.registered(file.harness) === undefined;
              }),
            );
          if (Object.is(def, profileItems)) {
            const files = original.config.collection(runtimeItems);
            const native = new Set(
              [...files.values()]
                .filter(file => file.harness !== undefined && this.registered(file.harness) !== undefined)
                .map(file => file.profile),
            );
            const shared = new Set(
              [...files.values()]
                .filter(file => file.harness === undefined || this.registered(file.harness) === undefined)
                .map(file => file.profile),
            );
            for (const [name, profile] of original.config.collection(profileItems))
              if (!native.has(name))
                for (const reference of profile.contents)
                  if (reference.startsWith('profile/')) shared.add(reference.slice('profile/'.length));
            return new Map([...held].filter(([name]) => !native.has(name) || shared.has(name)));
          }
          return held;
        }) as KernelPorts['config']['collection'],
      }),
    };
  }
  private file(name: string): RuntimeFile | undefined {
    return this.deps.kernel.config.collection(runtimeItems).get(name);
  }
  private nativeFile(name: string): boolean {
    const key = this.file(name)?.harness;
    return key !== undefined && supportedKindOfKey(key) === undefined;
  }
  private require(key: string): Registered {
    return this.registered(key) ?? refused(`${key} is not registered with runtime support on this machine`);
  }
  private profile(name: string, label: string): string | undefined {
    if (this.deps.kernel.config.fileState(profileItems, name).state === 'invalid')
      return refused(`Profile ${name} could not be read`);
    const profile = this.deps.kernel.config.collection(profileItems).get(name);
    if (profile === undefined) return refused(`Profile ${name} does not exist`);
    let model: string | undefined;
    for (const reference of profile.contents) {
      if (!reference.startsWith('modelSets/')) return unsupported(label);
      const set = this.deps.kernel.config.collection(modelSetItems).get(reference.slice('modelSets/'.length));
      if (this.deps.kernel.config.fileState(modelSetItems, reference.slice('modelSets/'.length)).state === 'invalid')
        return refused(`Model set ${reference} could not be read`);
      if (set === undefined) return refused(`Model set ${reference} does not exist`);
      model = set.default;
    }
    return model;
  }
  private async read(
    name: string,
    file: RuntimeFile = this.file(name) ?? refused(`Runtime ${name} does not exist`),
  ): Promise<Reading> {
    const registered = this.require(file.harness ?? '');
    if (this.deps.kernel.config.fileState(runtimeItems, name).state === 'invalid')
      return refused(`Runtime ${name} could not be read`);
    if (file.shell !== undefined) return unsupported(registered.label);
    const compatibility = await this.deps.logins.launchRefusal(file.login, registered.key);
    if (compatibility !== undefined) return refused(compatibility);
    const login = await this.deps.logins.get(LoginIdSchema.parse(file.login)).catch(() => undefined);
    if (login === undefined) return refused(`Login ${file.login} does not exist`);
    if (!login.harnesses.includes(registered.key))
      return refused(`Login ${file.login} cannot be spent by ${registered.label}`);
    const pinned = this.profile(file.profile, registered.label);
    let models: HarnessRuntimeModels;
    let installed: Awaited<ReturnType<HarnessRuntimeDescriptor['detect']>>;
    try {
      [models, installed] = await Promise.all([registered.runtime.models(file.login), this.detect(registered)]);
    } catch {
      return refused(`${registered.label} could not report its installation and models`);
    }
    const ids = new Set<string>();
    for (const choice of models.choices) {
      if (
        !choice.id ||
        !choice.label ||
        ids.has(choice.id) ||
        (choice.context !== undefined && (!Number.isSafeInteger(choice.context) || choice.context <= 0))
      )
        return refused(`${registered.label} reported an invalid model list`);
      ids.add(choice.id);
    }
    const preferred = pinned ?? (models.default !== undefined && ids.has(models.default) ? models.default : undefined);
    if (preferred !== undefined && !ids.has(preferred))
      return refused(`${registered.label} does not offer the chosen model`);
    const off = file.disabled ?? login.disabled;
    const activeOff =
      off !== undefined && (off.until === undefined || Date.parse(off.until) > this.deps.kernel.clock.nowMs());
    const reason = activeOff
      ? `${name} is switched off`
      : login.status.word === 'needs_sign_in'
        ? `Login ${file.login} needs sign-in`
        : models.choices.length === 0
          ? `${registered.label} has no models available`
          : !installed.found
            ? installed.reason
            : undefined;
    const launch = reason === undefined ? { available: true as const } : { available: false as const, reason };
    const discovery = {
      choices: models.choices.map(choice => ({
        id: choice.id,
        label: choice.label,
        available: true,
        efforts: [...(choice.variants ?? [])],
        ...(choice.context === undefined ? {} : { context: choice.context }),
        ...(choice.reasoning === undefined ? {} : { reasoning: choice.reasoning }),
      })),
      ...(preferred === undefined ? {} : { default: preferred }),
    };
    const summary: RuntimeSummary = {
      id: name as RuntimeId,
      harness: registered.key,
      login: file.login,
      profile: file.profile,
      launch,
    };
    const view: RuntimeView = {
      id: name,
      name,
      wrapper: name,
      harness: registered.key,
      harnessDisplayName: registered.label,
      credential: { id: file.login, store: login.store, status: login.status.word },
      profile: file.profile,
      stack: { harness: registered.key, available: launch, applied: [], skipped: [], conflicts: [], partial: [] },
      modelSet: { source: 'harness-default' },
      discovery,
      launch,
      sameAs: [],
    };
    return {
      summary,
      view,
      models: { choices: models.choices, ...(preferred === undefined ? {} : { default: preferred }) },
    };
  }
  private async views(): Promise<readonly RuntimeView[]> {
    const rows: RuntimeView[] = [];
    for (const [name, file] of this.deps.kernel.config.collection(runtimeItems)) {
      if (file.harness === undefined || supportedKindOfKey(file.harness) !== undefined) continue;
      try {
        rows.push((await this.read(name, file)).view);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        const login = await this.deps.logins.get(LoginIdSchema.parse(file.login)).catch(() => undefined);
        if (login === undefined) continue;
        rows.push({
          id: name,
          name,
          wrapper: name,
          harness: file.harness,
          harnessDisplayName: this.registered(file.harness)?.label ?? file.harness,
          credential: { id: file.login, store: login.store, status: login.status.word },
          profile: file.profile,
          stack: {
            harness: file.harness,
            available: { available: false, reason: error.message },
            applied: [],
            skipped: [],
            conflicts: [],
            partial: [],
          },
          modelSet: { source: 'harness-default' },
          launch: { available: false, reason: error.message },
          sameAs: [],
        });
      }
    }
    return rows;
  }

  api(base: RuntimeApi): RuntimeApi {
    const list = async () => {
      const generic = await this.views();
      return [
        ...(await base.list()).filter(row => !this.nativeFile(row.id)),
        ...generic.map(row => ({
          id: row.name as RuntimeId,
          harness: row.harness,
          login: row.credential.id,
          profile: row.profile,
          launch: row.launch,
        })),
      ];
    };
    return {
      ...base,
      get: async name => (this.nativeFile(name) ? (await list()).find(row => row.id === name) : await base.get(name)),
      list,
      listFor: async logins => {
        const ids = new Set(logins.map(login => login.id as string));
        const generic: RuntimeSummary[] = [];
        for (const [name, file] of this.deps.kernel.config.collection(runtimeItems)) {
          if (!this.nativeFile(name) || !ids.has(file.login)) continue;
          const label = this.registered(file.harness ?? '')?.label ?? file.harness ?? name;
          generic.push({
            id: name as RuntimeId,
            harness: file.harness ?? '',
            login: file.login,
            profile: file.profile,
            launch: { available: false, reason: `${label}: discovery must be checked before launch` },
          });
        }
        return [...(await base.listFor(logins)).filter(row => !this.nativeFile(row.id)), ...generic];
      },
      default: async () => {
        const name = this.deps.kernel.config.file(runtimesConfig)?.defaultRuntime;
        return name !== undefined && this.nativeFile(name) ? (name as RuntimeId) : await base.default();
      },
      resolve: async (name, harness) => {
        name ??= this.deps.kernel.config.file(runtimesConfig)?.defaultRuntime as RuntimeId | undefined;
        if (name === undefined || !this.nativeFile(name)) return await base.resolve(name, harness);
        try {
          const file = this.file(name);
          if (file !== undefined && harness !== undefined && harness !== file.harness) {
            const refusal = await this.deps.logins.launchRefusal(file.login, harness);
            if (refusal !== undefined)
              return { ok: false as const, refusal: 'not_signed_in' as const, sentence: refusal };
          }
          const runtime = (await this.read(name)).summary;
          return runtime.launch.available
            ? { ok: true as const, runtime }
            : { ok: false as const, refusal: 'disabled' as const, sentence: runtime.launch.reason };
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          return { ok: false as const, refusal: 'unknown' as const, sentence: error.message };
        }
      },
    };
  }

  start(base: RuntimeStartSource): RuntimeStartSource {
    return {
      ...base,
      catalog: async name => {
        if (!this.nativeFile(name)) return await base.catalog?.(name);
        const row = await this.read(name);
        return {
          harness: row.summary.harness,
          source: 'wrapper-inventory' as const,
          choices: row.models.choices.map(choice => ({
            value: choice.id,
            label: choice.label,
            ...(choice.context === undefined ? {} : { context: choice.context }),
            reasoningEfforts: (choice.variants ?? []).map(value => ({ value })),
            ...(choice.id === row.models.default ? { isDefault: true as const } : {}),
          })),
        };
      },
    };
  }
  layers(base: RuntimeLayersApi): RuntimeLayersApi {
    return {
      ...base,
      layers: async id => {
        const file = this.file(id);
        if (this.nativeFile(id) && file !== undefined)
          this.profile(file.profile, this.require(file.harness ?? '').label);
        return await base.layers(id);
      },
      changeProfileLayers: async (change, governance) => {
        if (change.kind === 'add')
          for (const [name, file] of this.deps.kernel.config.collection(runtimeItems))
            if (this.nativeFile(name) && file.profile === change.profile)
              return {
                kind: 'refused',
                code: 'fleet_change_refused',
                sentence: `${this.require(file.harness ?? '').label}: not supported by Ferretry yet`,
              };
        return await base.changeProfileLayers(change, governance);
      },
    };
  }
  async decide(input: StartDecideInput): Promise<HookDecision | undefined> {
    if (input.runtime === undefined || !this.nativeFile(input.runtime)) return undefined;
    try {
      const row = await this.read(input.runtime);
      if (!row.summary.launch.available) return { allow: false, reason: row.summary.launch.reason };
      if (input.harness !== row.summary.harness)
        return { allow: false, reason: 'The registered runtime harness changed' };
      if (input.compactAt !== undefined || input.fast === true)
        return unsupported(row.view.harnessDisplayName ?? input.harness);
      if (input.model === undefined && row.models.default === undefined)
        return { allow: false, reason: `Choose a model for ${row.view.harnessDisplayName}` };
      if (input.model !== undefined && !row.models.choices.some(model => model.id === input.model))
        return { allow: false, reason: 'This runtime does not offer the chosen model' };
      return { allow: true };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { allow: false, reason: error.message };
    }
  }

  private view(record: FleetProposalRecord<Staged, NativeChange>): AccountChangeView {
    return {
      id: record.id,
      revision: record.revision,
      change: record.mutation,
      summary: record.summary,
      consequences: [],
      expiresAt: instantFromEpochMs(record.expiresAt),
      state: record.state,
      preview: {
        kind: 'apply',
        operations: [],
        documents: record.payload.documents.map(document => ({
          path: Object.is(document.def, runtimesConfig) ? 'runtimes.yaml' : `runtimes/${document.name}.yaml`,
          bytes:
            typeof document.edit === 'string'
              ? Buffer.byteLength(document.edit)
              : 'remove' in document.edit
                ? 0
                : Buffer.byteLength(JSON.stringify(document.edit.patch)),
        })),
        runtimes: [],
      },
    };
  }
  private nativeChange(change: AccountChange): boolean {
    if (change.kind === 'runtime.put')
      return (
        this.nativeFile(change.name) ||
        (change.harness !== undefined && supportedKindOfKey(change.harness) === undefined)
      );
    return (change.kind === 'runtime.remove' || change.kind === 'runtime.rename') && this.nativeFile(change.name);
  }
  private async propose(change: AccountChange): Promise<AccountChangeView> {
    if (change.kind !== 'runtime.put' && change.kind !== 'runtime.remove') return unsupported('This harness');
    const { config } = this.deps.kernel;
    const current = this.file(change.name);
    const revision = await config.etag(runtimeItems, change.name);
    const dependencies: Staged['dependencies'][number][] = [];
    let edit: ConfigWriteAllDocument['edit'];
    if (change.kind === 'runtime.remove') {
      if (current === undefined) return refused(`Runtime ${change.name} does not exist`);
      edit = { remove: true };
    } else {
      if (change.create && current !== undefined) return refused(`Runtime ${change.name} already exists`);
      const registered = this.require(change.harness ?? current?.harness ?? '');
      if (current !== undefined && !this.nativeFile(change.name)) return unsupported(registered.label);
      const value: RuntimeFile = {
        ...current,
        harness: registered.key,
        login: change.credential,
        profile: change.profile,
      };
      this.profile(change.profile, registered.label);
      dependencies.push({
        def: profileItems,
        name: change.profile,
        etag: await config.etag(profileItems, change.profile),
      });
      for (const reference of new Set(config.collection(profileItems).get(change.profile)?.contents ?? [])) {
        const name = reference.slice('modelSets/'.length);
        dependencies.push({ def: modelSetItems, name, etag: await config.etag(modelSetItems, name) });
      }
      await this.read(change.name, value);
      edit =
        current === undefined
          ? `${JSON.stringify(value, null, 2)}\n`
          : { patch: { harness: value.harness, login: value.login, profile: value.profile } };
    }
    const documents: ConfigWriteAllDocument[] = [{ def: runtimeItems, name: change.name, edit, ifMatch: revision }];
    if (change.kind === 'runtime.remove' && config.file(runtimesConfig)?.defaultRuntime === change.name)
      documents.push({
        def: runtimesConfig,
        edit: { patch: { defaultRuntime: undefined } },
        ifMatch: await config.etag(runtimesConfig),
      });
    const record = this.#changes.open({
      revision,
      mutation: change,
      payload: { documents, dependencies },
      summary: `${change.kind === 'runtime.remove' ? 'Remove' : current === undefined ? 'Add' : 'Update'} runtime ${change.name}`,
    });
    return this.view(record);
  }

  assembly(base: RuntimesAssembly): RuntimesAssembly {
    return {
      ...base,
      catalog: overlay(base.catalog, {
        machine: async governance => {
          const old = await base.catalog.machine(governance);
          const tools = await Promise.all(
            this.registrations().map(async item => {
              const detected = await this.detect(item);
              return {
                harness: item.key,
                label: item.label,
                installed: detected.found,
                ...(detected.found ? { command: detected.binary } : {}),
              };
            }),
          );
          return {
            ...old,
            tools: [...old.tools, ...tools],
            runtimeCount: old.runtimeCount + (await this.views()).length,
          };
        },
        runtimes: async () => {
          const old = await base.catalog.runtimes();
          return { ...old, runtimes: [...old.runtimes, ...(await this.views())] };
        },
        propose: async (change, caller) => {
          if (this.nativeChange(change)) return await this.propose(change);
          if (change.kind === 'profile.put' || change.kind === 'profile.remove')
            for (const [name, file] of this.deps.kernel.config.collection(runtimeItems))
              if (this.nativeFile(name) && file.profile === change.name)
                return unsupported(this.require(file.harness ?? '').label);
          if (
            change.kind === 'component.put' &&
            'harness' in change.component &&
            typeof change.component.harness === 'string' &&
            supportedKindOfKey(change.component.harness) === undefined
          )
            return unsupported(this.require(change.component.harness).label);
          if (change.kind === 'setup.import' && change.include?.some(key => supportedKindOfKey(key) === undefined))
            return unsupported('This harness');
          return await base.catalog.propose(change, caller);
        },
        read: async id =>
          this.#changes.knows(id) ? this.view(this.#changes.require(id)) : await base.catalog.read(id),
        apply: async (id, governance, stepUp, bracket) => {
          if (!this.#changes.knows(id)) return await base.catalog.apply(id, governance, stepUp, bracket);
          return await base.catalog.serialise(async () => {
            let record: FleetProposalRecord<Staged, NativeChange>;
            try {
              record = this.#changes.consume(id);
            } catch {
              return refused('The runtime change has expired or was already applied; review it again');
            }
            try {
              bracket?.known?.();
              assertRequestLive(bracket);
              const outcome = await this.deps.kernel.config.writeAll([
                ...record.payload.documents,
                ...record.payload.dependencies.map(dependency => ({
                  def: dependency.def,
                  name: dependency.name,
                  edit: { patch: {} },
                  ifMatch: dependency.etag,
                })),
              ]);
              if (outcome.kind !== 'written') {
                this.#changes.restore(record);
                return refused(
                  outcome.kind === 'held'
                    ? outcome.sentence
                    : 'The runtime configuration could not be written; review it again',
                );
              }
            } catch (error) {
              this.#changes.restore(record);
              throw error;
            }
            this.deps.kernel.events.publish(RuntimesChanged, {
              runtimes: [record.mutation.name],
              profiles: [],
              modelSets: [],
            });
            return { outcome: 'executed' as const, executor: 'runtime' as const, summary: record.summary };
          });
        },
      }),
      setup: overlay(base.setup, {
        exportBundle: async () => {
          const native = (await this.views())[0];
          if (native !== undefined) return unsupported(native.harnessDisplayName ?? native.harness);
          return await base.setup.exportBundle();
        },
        reviewClone: async (request, governance) => {
          const native = (await this.views())[0];
          if (native !== undefined) return unsupported(native.harnessDisplayName ?? native.harness);
          return await base.setup.reviewClone(request, governance);
        },
        scan: async options => {
          const old = await base.setup.scan(options);
          const tools = await Promise.all(
            this.registrations().map(async item => {
              const found = await this.detect(item);
              if (found.found) return { harness: item.key, label: item.label, installed: true as const };
              const manualCommand = Object.entries(item.runtime.install ?? {}).map(([manager, args]) =>
                [manager, ...(args ?? [])].join(' '),
              )[0];
              const command = (await this.installChoice(item))?.command;
              return {
                harness: item.key,
                label: item.label,
                installed: false as const,
                install:
                  command === undefined
                    ? {
                        kind: 'no-package-manager' as const,
                        reason:
                          manualCommand === undefined
                            ? `${item.label}: not supported by Ferretry yet`
                            : `No supported package manager is available for ${item.label}`,
                        manualCommand: manualCommand ?? item.runtime.binary,
                      }
                    : { kind: 'runnable' as const, command },
              };
            }),
          );
          return { ...old, tools: [...old.tools, ...tools] };
        },
        installTools: async (request, governance) => {
          const generic = request.harnesses.filter(key => supportedKindOfKey(key) === undefined);
          if (generic.length === 0) return await base.setup.installTools(request, governance);
          const registrations = generic.map(key => this.require(key));
          const plans = await Promise.all(
            registrations.map(async item =>
              (await this.detect(item)).found
                ? { item, installed: true as const }
                : {
                    item,
                    installed: false as const,
                    choice: (await this.installChoice(item)) ?? unsupported(item.label),
                  },
            ),
          );
          for (const plan of plans) {
            if (plan.installed) continue;
            const { item, choice } = plan;
            if (request.shown?.some(shown => shown.harness === item.key && shown.command !== choice.command))
              return refused('The install command changed; check the tool again');
          }
          const outcomes: ToolInstallOutcome[] = [];
          for (const plan of plans) {
            const { item } = plan;
            if (plan.installed) {
              outcomes.push({ harness: item.key, outcome: 'already-installed' });
              continue;
            }
            const { choice } = plan;
            let success = false;
            try {
              success =
                (await this.deps.kernel.spawn.run(choice.program, choice.args, { sealed: true, timeout: minutes(15) }))
                  .exitCode === 0;
            } catch {
              /* The fixed refusal below never quotes package-manager output. */
            }
            const found = success && (await this.detect(item)).found;
            outcomes.push(
              found
                ? { harness: item.key, outcome: 'installed', command: choice.command, output: [] }
                : {
                    harness: item.key,
                    outcome: 'failed',
                    cause: 'failed',
                    reason: `${item.label} could not be installed`,
                    manualCommand: choice.command,
                    output: [],
                  },
            );
          }
          const accountHarnesses = request.harnesses.filter(key => supportedKindOfKey(key) !== undefined);
          if (accountHarnesses.length > 0)
            outcomes.push(
              ...(await base.setup.installTools({ ...request, harnesses: accountHarnesses }, governance)).outcomes,
            );
          return { outcomes };
        },
      }),
    };
  }
  private async installChoice(item: Registered) {
    for (const [manager, args] of Object.entries(item.runtime.install ?? {})) {
      const program = manager;
      if (args === undefined) continue;
      const path = await this.deps.kernel.paths.which(program);
      if (path !== undefined) return { program: path, args, command: [program, ...args].join(' ') };
    }
    return undefined;
  }
}
