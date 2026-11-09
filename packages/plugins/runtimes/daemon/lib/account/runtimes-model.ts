/**
 * The account model as the Runtimes plugin can read it from what it is given: its OWN files (`runtimes.yaml`,
 * `runtimes/<name>.yaml`, `profiles/<name>.yaml`, `model-sets/<name>.yaml`), the facts Logins offers about each login and
 * its environment logins' variable templates, and the component documents the plugins that own the other kinds provide
 * through the profile component source (`../../../contract/component-source.ts`).
 *
 * Today's evaluator (`assembleAccountModel`) read every fleet file from one folder. In 5.0 the folders belong to several
 * plugins and Runtimes may read only its own, so this assembles the same {@link AccountModel} from what it may read and
 * says, in `unreadable`, every part it had to stand in for:
 *
 *  - an environment login whose templates Logins did not give is stood in for with the variables the login view can state;
 *  - a layer naming a component of a kind (`instructions`, `mcp`, `skills`, `settings`, `hooks`) that NO provider answered
 *    for, or whose provider failed or gave something that is not a component, is kept in its profile (so an edit never
 *    drops it) and stood in for by an empty component of that kind.
 *
 * What stands in for something is NEVER written into a home: the caller refuses an apply while `unreadable` is not empty
 * and refuses a model that names a stood-in login (`stoodInLogins`, `standInsNamedBy`; `../../adapters/runtimes-config-files.ts`),
 * so a stand-in can be read and shown but can never replace a real document on disk. A kind whose owner answered is real: its components are in the model exactly as the owner projected them.
 *
 * Pure: no filesystem, no clock, no environment.
 */
import { createHash } from 'node:crypto';
import type { EnvironmentLoginTemplate, LoginView } from '@ferretry/plugin-logins/contract';
import {
  PROFILE_COMPONENT_KINDS,
  type ProfileComponentKind,
  type ModelSetFile,
  type ProfileFile,
  type RuntimeFile,
  type RuntimesFile,
} from '../../../contract/index.ts';
import { harnessKindOfKey, type HarnessKind } from '../manifest.ts';
import {
  type AccountModel,
  AccountModelSchema,
  type Credential,
  type ModelSetComponent,
  parseLayerReference,
  type Runtime,
} from './schema.ts';

/** What reading one kind of component from its owners came to. */
export type KindReading =
  /** Every source of the kind answered: its components, in the model's shape, by name. */
  | {
      readonly state: 'read';
      readonly components: ReadonlyMap<string, unknown>;
      /**
       * Set when a part of the kind that is per harness is not running (the owner turned Codex off): what the running parts
       * gave is real, and a layer that names a component none of them has is unread, for this reason, not a gap in the files.
       */
      readonly partial?: string;
    }
  /** No source answered (none exists, it is off, it threw, or it gave something invalid): why, in a sentence of names and rules. */
  | { readonly state: 'unread'; readonly reason: string };

/** Every kind another plugin owns, as read at one moment. */
export type ComponentReading = Readonly<Record<ProfileComponentKind, KindReading>>;

/** Everything the model is assembled from. */
export interface RuntimesFiles {
  readonly runtimes: ReadonlyMap<string, RuntimeFile>;
  readonly profiles: ReadonlyMap<string, ProfileFile>;
  readonly modelSets: ReadonlyMap<string, ModelSetFile>;
  /** `runtimes.yaml`, or `undefined` when it does not exist. */
  readonly settings: RuntimesFile | undefined;
  /** Logins' safe facts: never a token and never a `${secret:NAME}` template. */
  readonly logins: readonly LoginView[];
  /** The environment logins' variable templates by login id; `undefined` when Logins could not give them. */
  readonly templates: ReadonlyMap<string, EnvironmentLoginTemplate> | undefined;
  /** The components the owning plugins provided, per kind. */
  readonly components: ComponentReading;
}

/** An environment login whose variables the model holds as a stand-in, and why (names and rules only, never a value). */
export interface StoodInLogin {
  readonly id: string;
  readonly because: string;
}

/**
 * The stood-in logins a model names: those a runtime of `model` uses. A login no runtime names is shown stood in and
 * holds nothing back; one a runtime names would have its stand-in written into that runtime's wrapper.
 */
export function standInsNamedBy(model: AccountModel, stoodIn: readonly StoodInLogin[]): readonly StoodInLogin[] {
  const used = new Set(Object.values(model.runtimes).map(runtime => runtime.credential as string));
  return stoodIn.filter(login => used.has(login.id));
}

/**
 * The sentence a change is refused with when the home it would write names a login that stands in. It names each login
 * and why, and says nothing was changed; removing the runtimes that use the login stays possible.
 */
export const stoodInLoginSentence = (named: readonly StoodInLogin[]): string =>
  `nothing was changed: ${named
    .map(login => `the login "${login.id}" keeps its variables as ${login.because}`)
    .join(
      '; ',
    )}, so a runtime that uses ${named.length === 1 ? 'it' : 'them'} would be written with a stand-in in place of ${named.length === 1 ? 'its' : 'their'} variables (fix the login in Logins first, or remove the runtime that uses it)`;

/** What the files assemble to, and every part that is a stand-in rather than a document read. */
export interface RuntimesModel {
  readonly model: AccountModel;
  /**
   * Plain sentences naming what stands in (names only, never a value) for a component that could not be read; empty when
   * every one was read. While it is not empty NOTHING is written: a home built from it would replace what is there.
   */
  readonly unreadable: readonly string[];
  /**
   * The environment logins whose variables stand in (Logins withheld their templates or gave none), used or not. Judged
   * against the model a change would WRITE ({@link standInsNamedBy}), never against the model in effect: a change that
   * removes the last runtime on such a login must stay possible.
   */
  readonly stoodInLogins: readonly StoodInLogin[];
  /** The number of files and logins the model came from; zero is a machine nobody has set up. */
  readonly sources: number;
  /** A digest of the model, so a staged change can tell the machine moved under it. */
  readonly revision: string;
}

/** Nothing read: what a caller that has no providers (a test of the pure part, an unavailable seam) gives. */
export const NO_COMPONENTS: ComponentReading = Object.fromEntries(
  PROFILE_COMPONENT_KINDS.map(kind => [
    kind,
    { state: 'unread', reason: 'no part of Ferretry provides these components yet' } as const,
  ]),
) as ComponentReading;

/** The word a stand-in carries where a document would name a file, so nothing mistakes it for one. */
const STAND_IN = 'not-read';

const standIn = (kind: ProfileComponentKind): unknown => {
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

/** A login as the model holds it, from the facts Logins states about it and, for an environment login, its templates. */
function credentialOf(
  view: LoginView,
  template: EnvironmentLoginTemplate | undefined,
): { readonly credential: Credential; readonly stoodIn: boolean } {
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
  if (template?.kind === 'templates') {
    // The login's own templates, as Logins gave them: a secret is a `${secret:NAME}` reference, never a value.
    return {
      credential: {
        ...base,
        ...(template.env === undefined ? {} : { env: template.env }),
        ...(template.preset === undefined ? {} : { preset: template.preset }),
        ...(template.cloudCredential === undefined ? {} : { cloudCredential: template.cloudCredential }),
        ...(template.codexProvider === undefined ? {} : { codexProvider: template.codexProvider }),
        ...(template.claude === undefined ? {} : { claude: template.claude }),
        ...(template.codex === undefined ? {} : { codex: template.codex }),
      } as Credential,
      stoodIn: false,
    };
  }
  // No templates: the variables the view states. A secret's template is not among them, so the variable is given as a
  // reference to the one secret it names; a login that cannot be stated at all gets one empty variable.
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
function foreignLayers(
  profiles: ReadonlyMap<string, ProfileFile>,
): ReadonlyMap<ProfileComponentKind, ReadonlySet<string>> {
  const named = new Map<ProfileComponentKind, Set<string>>(
    PROFILE_COMPONENT_KINDS.map(kind => [kind, new Set<string>()]),
  );
  for (const profile of profiles.values()) {
    for (const layer of profile.contents) {
      const reference = parseLayerReference(layer);
      if (reference?.kind !== 'component') continue;
      if ((PROFILE_COMPONENT_KINDS as readonly string[]).includes(reference.componentKind))
        named.get(reference.componentKind as ProfileComponentKind)?.add(reference.name);
    }
  }
  return named;
}

/**
 * Assembles the model. Throws the account model's `ZodError` when a cross-file rule fails (a runtime naming a login or
 * profile that is not there, a layer naming a component its owner does not have): the caller words it as the files' own
 * problem.
 */
export function assembleRuntimesModel(files: RuntimesFiles): RuntimesModel {
  const unreadable: string[] = [];
  const credentials: Record<string, Credential> = {};
  // A login whose variables stand in blocks only a model that names it (see `standInsNamedBy`), so it is kept apart from
  // the components: the model in effect may use it and still be changed by a change that stops using it.
  const stoodInLogins: StoodInLogin[] = [];
  for (const view of files.logins) {
    const template = files.templates?.get(view.id as string);
    const { credential, stoodIn } = credentialOf(view, template);
    credentials[view.id as string] = credential;
    if (stoodIn)
      stoodInLogins.push({
        id: view.id as string,
        because:
          template?.kind === 'withheld'
            ? '${secret:NAME} templates, which Logins withheld (its file is not a clean, checked version)'
            : '${secret:NAME} templates, which Logins did not give to Runtimes',
      });
  }
  const components: Record<string, Record<string, unknown>> = {
    modelSets: Object.fromEntries([...files.modelSets].map(([name, file]) => [name, modelSetOf(file)])),
  };
  for (const [kind, names] of foreignLayers(files.profiles)) {
    const reading = files.components[kind];
    if (reading.state === 'read') {
      // The owner's components, as it projected them. A name a layer uses that the owner does not have is a real gap in
      // the machine's files, which the cross-reference rules below refuse by name.
      components[kind] = Object.fromEntries(reading.components);
      if (reading.partial === undefined) continue;
      // ...unless a part of the kind is not running: then the name may be one of ITS components, which stands in.
      for (const name of [...names].toSorted((left, right) => left.localeCompare(right))) {
        if (reading.components.has(name)) continue;
        components[kind][name] = standIn(kind);
        unreadable.push(
          `the ${kind} component "${name}" could not be read from the part of Ferretry that owns it: ${reading.partial}`,
        );
      }
      continue;
    }
    components[kind] = Object.fromEntries([...names].map(name => [name, standIn(kind)]));
    for (const name of [...names].toSorted((left, right) => left.localeCompare(right)))
      unreadable.push(
        `the ${kind} component "${name}" could not be read from the part of Ferretry that owns it: ${reading.reason}`,
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
    stoodInLogins,
    sources:
      files.runtimes.size +
      files.profiles.size +
      files.modelSets.size +
      files.logins.length +
      (files.settings === undefined ? 0 : 1),
    revision: createHash('sha256').update(JSON.stringify(model)).digest('hex'),
  };
}
