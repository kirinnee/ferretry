/**
 * The account model as the Runtimes plugin can read it from the files it is given: its OWN files (`runtimes.yaml`,
 * `runtimes/<name>.yaml`, `profiles/<name>.yaml`, `model-sets/<name>.yaml`) and the facts Logins offers about each login.
 *
 * Today's evaluator (`assembleAccountModel`) read every fleet file from one folder. In 5.0 the folders belong to
 * several plugins and Runtimes may read only its own, so this assembles the same {@link AccountModel} from what it may
 * read and says, in `unreadable`, every part it had to stand in for:
 *
 *  - a login's `env` is a `${secret:NAME}` TEMPLATE in its file and the Logins view carries the secret's name, not the
 *    template, so an environment login is stood in for with the variables the view can state;
 *  - a layer naming a component of a kind another plugin owns (`instructions`, `mcp`, `skills`, `settings`, `hooks`)
 *    is kept in its profile, so an edit never drops it, and is stood in for by an empty component of that kind.
 *
 * What stands in for something is NEVER written into a home: the caller refuses an apply while `unreadable` is not
 * empty (`../../adapters/runtimes-config-files.ts`), so a stand-in can be read and shown but can never replace a real
 * document on disk.
 *
 * Pure: no filesystem, no clock, no environment.
 */
import { createHash } from 'node:crypto';
import type { LoginView } from '@ferretry/plugin-logins/contract';
import type { ModelSetFile, ProfileFile, RuntimeFile, RuntimesFile } from '../../../contract/index.ts';
import { harnessKindOfKey, type HarnessKind } from '../manifest.ts';
import {
  type AccountModel,
  AccountModelSchema,
  type Credential,
  type ModelSetComponent,
  parseLayerReference,
  type Runtime,
} from './schema.ts';

/** Everything the model is assembled from. */
export interface RuntimesFiles {
  readonly runtimes: ReadonlyMap<string, RuntimeFile>;
  readonly profiles: ReadonlyMap<string, ProfileFile>;
  readonly modelSets: ReadonlyMap<string, ModelSetFile>;
  /** `runtimes.yaml`, or `undefined` when it does not exist. */
  readonly settings: RuntimesFile | undefined;
  /** Logins' safe facts: never a token and never a `${secret:NAME}` template. */
  readonly logins: readonly LoginView[];
}

/** What the files assemble to, and every part that is a stand-in rather than a document read. */
export interface RuntimesModel {
  readonly model: AccountModel;
  /** Plain sentences naming what stands in (names only, never a value); empty when every part was read. */
  readonly unreadable: readonly string[];
  /** The number of files and logins the model came from; zero is a machine nobody has set up. */
  readonly sources: number;
  /** A digest of the model, so a staged change can tell the machine moved under it. */
  readonly revision: string;
}

/** The kinds whose components another plugin owns. */
const FOREIGN_KINDS = ['instructions', 'mcp', 'skills', 'settings', 'hooks'] as const;
type ForeignKind = (typeof FOREIGN_KINDS)[number];

/** The word a stand-in carries where a document would name a file, so nothing mistakes it for one. */
const STAND_IN = 'not-read';

const standIn = (kind: ForeignKind): unknown => {
  switch (kind) {
    case 'instructions':
      return { file: STAND_IN };
    case 'mcp':
      // A server reached at an address, so nothing reports a command that is "missing".
      return { url: `https://${STAND_IN}.invalid/` };
    case 'skills':
      return { items: [STAND_IN] };
    case 'settings':
      return { harness: 'claude', flags: [STAND_IN] };
    case 'hooks':
      return { harness: 'claude', directory: STAND_IN };
  }
};

/** A login as the model holds it, from the facts Logins states about it. */
function credentialOf(view: LoginView): { readonly credential: Credential; readonly stoodIn: boolean } {
  const harness: HarnessKind = harnessKindOfKey(view.harness);
  const disabled =
    view.disabled === undefined || view.disabled.source !== 'login'
      ? {}
      : {
          disabled: {
            ...(view.disabled.reason === undefined ? {} : { reason: view.disabled.reason }),
            ...(view.disabled.until === undefined ? {} : { until: view.disabled.until }),
          },
        };
  const base = {
    harness,
    store: view.store,
    ...(view.label === undefined ? {} : { label: view.label }),
    ...(view.clonedFrom === undefined ? {} : { clonedFrom: view.clonedFrom }),
    ...(view.clonedFromDaemon === undefined ? {} : { clonedFromDaemon: view.clonedFromDaemon }),
    ...disabled,
  };
  if (view.store !== 'environment') return { credential: base as Credential, stoodIn: false };
  // An environment login: the variables the view states. A secret's template is not among them, so the variable is
  // given as a reference to the one secret it names; a login that cannot be stated at all gets one empty variable.
  const env: Record<string, string> = {};
  for (const variable of view.environment?.variables ?? []) {
    if (variable.kind === 'plain') env[variable.name] = variable.value;
    else if (variable.kind === 'secret') env[variable.name] = `\${secret:${variable.secrets[0] ?? 'unknown'}}`;
  }
  if (Object.keys(env).length === 0 && view.environment?.cloudCredential === undefined) env.NOT_READ = STAND_IN;
  return { credential: { ...base, env } as Credential, stoodIn: true };
}

/** The `Runtime` a runtime file declares. */
function runtimeOf(file: RuntimeFile): Runtime {
  return {
    credential: file.login,
    profile: file.profile,
    ...(file.harness === undefined ? {} : { harness: harnessKindOfKey(file.harness) }),
    ...(file.shell === undefined ? {} : { shell: file.shell }),
    agent: file.agent,
    ...(file.disabled === undefined ? {} : { disabled: file.disabled }),
    ...(file.compactAt === undefined ? {} : { compactAt: file.compactAt }),
    ...(file.clonedFromKey === undefined ? {} : { clonedFromKey: file.clonedFromKey }),
  } as Runtime;
}

const modelSetOf = (file: ModelSetFile): ModelSetComponent => ({
  models: [...file.models],
  default: file.default,
  ...(file.clonedFrom === undefined ? {} : { clonedFrom: file.clonedFrom }),
  ...(file.clonedFromDaemon === undefined ? {} : { clonedFromDaemon: file.clonedFromDaemon }),
  ...(file.clonedFromKey === undefined ? {} : { clonedFromKey: file.clonedFromKey }),
});

/** The layers every profile names whose component another plugin owns, as `kind/name`. */
function foreignLayers(profiles: ReadonlyMap<string, ProfileFile>): ReadonlyMap<ForeignKind, ReadonlySet<string>> {
  const named = new Map<ForeignKind, Set<string>>(FOREIGN_KINDS.map(kind => [kind, new Set<string>()]));
  for (const profile of profiles.values()) {
    for (const layer of profile.contents) {
      const reference = parseLayerReference(layer);
      if (reference?.kind !== 'component') continue;
      if ((FOREIGN_KINDS as readonly string[]).includes(reference.componentKind))
        named.get(reference.componentKind as ForeignKind)?.add(reference.name);
    }
  }
  return named;
}

/**
 * Assembles the model. Throws the account model's `ZodError` when a cross-file rule fails (a runtime naming a login or
 * profile that is not there): the caller words it as the files' own problem.
 */
export function assembleRuntimesModel(files: RuntimesFiles): RuntimesModel {
  const unreadable: string[] = [];
  const credentials: Record<string, Credential> = {};
  for (const view of files.logins) {
    const { credential, stoodIn } = credentialOf(view);
    credentials[view.id as string] = credential;
    if (stoodIn)
      unreadable.push(
        `login "${view.id as string}" keeps its variables as ` +
          '${secret:NAME} templates, which Logins does not show to Runtimes',
      );
  }
  const components: Record<string, Record<string, unknown>> = {
    modelSets: Object.fromEntries([...files.modelSets].map(([name, file]) => [name, modelSetOf(file)])),
  };
  for (const [kind, names] of foreignLayers(files.profiles)) {
    components[kind] = Object.fromEntries([...names].map(name => [name, standIn(kind)]));
    for (const name of [...names].toSorted((left, right) => left.localeCompare(right)))
      unreadable.push(
        `the ${kind} component "${name}" belongs to another part of Ferretry, which Runtimes cannot read`,
      );
  }
  const document = {
    version: 1,
    machine: {
      ...(files.settings?.defaultRuntime === undefined ? {} : { defaultRuntime: files.settings.defaultRuntime }),
      ...(files.settings?.autoResume === undefined ? {} : { autoResume: files.settings.autoResume }),
    },
    credentials,
    components,
    profiles: Object.fromEntries(
      [...files.profiles].map(([name, profile]) => [
        name,
        {
          layers: [...profile.contents],
          ...(profile.compactAt === undefined ? {} : { compactAt: profile.compactAt }),
          ...(profile.clonedFromKey === undefined ? {} : { clonedFromKey: profile.clonedFromKey }),
        },
      ]),
    ),
    runtimes: Object.fromEntries([...files.runtimes].map(([name, file]) => [name, runtimeOf(file)])),
  };
  const model = AccountModelSchema.parse(document);
  return {
    model,
    unreadable,
    sources:
      files.runtimes.size +
      files.profiles.size +
      files.modelSets.size +
      files.logins.length +
      (files.settings === undefined ? 0 : 1),
    revision: createHash('sha256').update(JSON.stringify(model)).digest('hex'),
  };
}
