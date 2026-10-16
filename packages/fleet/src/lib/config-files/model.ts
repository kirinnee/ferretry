/**
 * The account model and its files, both ways: the files assembled into one {@link AccountModel}, and
 * a model split back into the files that hold it.
 *
 * One file per building block (docs/config-files.md):
 *
 * - `machine.yaml` — `machine` and `advanced`;
 * - `logins/<id>.yaml` — one credential;
 * - `components/<kind>/<name>.yaml` — one component;
 * - `profiles/<name>.yaml` — one profile, its `contents` the model's `layers`;
 * - `runtimes/<name>.yaml` — one runtime.
 *
 * The cross-file rules — a profile naming a component that is not there, a runtime naming a login
 * that is not there — are the account model's own (`AccountModelSchema`), so they are checked by
 * parsing the assembled model, and an issue they raise is mapped back to the file and the line it is
 * about.
 *
 * Pure.
 */
import {
  CONFIG_COMPONENT_KINDS,
  type ConfigComponentKind,
  type ConfigFileAddress,
  configFilePath,
} from '@ferretry/protocol';
import {
  ACCOUNT_MODEL_VERSION,
  type AccountModel,
  AccountModelSchema,
  type ComponentOf,
  type Credential,
  type Runtime,
} from '../account/schema.ts';
import type { ConfigValues, MachineFileValue } from './kinds.ts';

/** One fleet file's meaning, by its path. */
export interface FleetFileValue {
  readonly address: ConfigFileAddress;
  readonly value: ConfigValues[keyof ConfigValues];
}

const FLEET_KINDS: ReadonlySet<ConfigFileAddress['kind']> = new Set([
  'machine',
  'login',
  'component',
  'profile',
  'runtime',
]);

/** Whether a file is part of the account model (as opposed to Warden, Learning or Voice). */
export const isFleetFile = (address: ConfigFileAddress): boolean => FLEET_KINDS.has(address.kind);

/** The model's input document, before the account model's own parse fills defaults and checks it. */
export function assembleAccountDocument(files: Iterable<FleetFileValue>): Record<string, unknown> {
  const components: Record<string, Record<string, unknown>> = Object.fromEntries(
    CONFIG_COMPONENT_KINDS.map(kind => [kind, {}]),
  );
  const document: Record<string, unknown> & {
    credentials: Record<string, unknown>;
    profiles: Record<string, unknown>;
    runtimes: Record<string, unknown>;
  } = { version: ACCOUNT_MODEL_VERSION, credentials: {}, components, profiles: {}, runtimes: {} };
  for (const { address, value } of files) {
    switch (address.kind) {
      case 'machine': {
        const { machine, advanced } = value as MachineFileValue;
        document.machine = machine;
        document.advanced = advanced;
        break;
      }
      case 'login':
        document.credentials[address.name] = value;
        break;
      case 'component':
        (components[address.componentKind] as Record<string, unknown>)[address.name] = value;
        break;
      case 'profile':
        document.profiles[address.name] = value;
        break;
      case 'runtime':
        document.runtimes[address.name] = value;
        break;
      default:
        break;
    }
  }
  return document;
}

/** Assemble and check. Throws the account model's `ZodError` when a cross-file rule fails. */
export function assembleAccountModel(files: Iterable<FleetFileValue>): AccountModel {
  return AccountModelSchema.parse(assembleAccountDocument(files));
}

/** Every file a model is held in, by path, with what each means. */
export function accountModelFiles(model: AccountModel): ReadonlyMap<string, FleetFileValue> {
  const files = new Map<string, FleetFileValue>();
  const add = (address: ConfigFileAddress, value: ConfigValues[keyof ConfigValues]): void => {
    files.set(configFilePath(address), { address, value });
  };
  add({ kind: 'machine' }, { machine: model.machine, advanced: model.advanced });
  for (const [name, credential] of Object.entries(model.credentials) as [string, Credential][]) {
    add({ kind: 'login', name }, credential);
  }
  for (const componentKind of CONFIG_COMPONENT_KINDS) {
    for (const [name, component] of Object.entries(model.components[componentKind]) as [
      string,
      ComponentOf<ConfigComponentKind>,
    ][]) {
      add({ kind: 'component', componentKind, name }, component);
    }
  }
  for (const [name, profile] of Object.entries(model.profiles)) add({ kind: 'profile', name }, profile);
  for (const [name, runtime] of Object.entries(model.runtimes) as [string, Runtime][]) {
    add({ kind: 'runtime', name }, runtime);
  }
  return files;
}

/** Where an issue the assembled model raised belongs: the file, and the path inside it. */
export interface ModelIssueSite {
  readonly file: string;
  readonly path: readonly PropertyKey[];
}

/** The file and in-file path an `AccountModelSchema` issue path is about. */
export function modelIssueSite(path: readonly PropertyKey[]): ModelIssueSite {
  const [section, first, second, ...rest] = path;
  const named = (address: ConfigFileAddress, inner: readonly PropertyKey[]): ModelIssueSite => ({
    file: configFilePath(address),
    path: inner,
  });
  const text = (value: PropertyKey | undefined): string | undefined => (typeof value === 'string' ? value : undefined);
  switch (section) {
    case 'credentials': {
      const name = text(first);
      if (name !== undefined) return named({ kind: 'login', name }, path.slice(2));
      break;
    }
    case 'components': {
      const kind = CONFIG_COMPONENT_KINDS.find(candidate => candidate === first);
      const name = text(second);
      if (kind !== undefined && name !== undefined) {
        return named({ kind: 'component', componentKind: kind, name }, rest);
      }
      break;
    }
    case 'profiles': {
      const name = text(first);
      if (name !== undefined) {
        return named({ kind: 'profile', name }, second === 'layers' ? ['contents', ...rest] : path.slice(2));
      }
      break;
    }
    case 'runtimes': {
      const name = text(first);
      if (name !== undefined) return named({ kind: 'runtime', name }, path.slice(2));
      break;
    }
    case 'machine':
      return named({ kind: 'machine' }, path.slice(1));
    case 'advanced':
      return named({ kind: 'machine' }, path);
    default:
      break;
  }
  return named({ kind: 'machine' }, []);
}
