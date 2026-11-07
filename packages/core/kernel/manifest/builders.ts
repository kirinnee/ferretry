import { PLUGIN_API, PluginIdSchema } from '../contract/ids.ts';
import type { MemberRouteDescriptor, RouteDescriptor } from '../contract/route.ts';
import { parseRouteKey } from '../contract/route.ts';
import type { SocketDescriptor } from '../contract/socket.ts';
import type {
  AppActionDecl,
  Manifest,
  MemberRouteDecl,
  PanelDecl,
  RendererDecl,
  RouteDecl,
  ScreenDecl,
  SettingsTabDecl,
  SlotName,
  SocketDecl,
  ToolDecl,
  VerbDecl,
} from './types.ts';

type WithoutPattern<T> = Omit<T, 'method' | 'path'>;

/** `route('GET /v1/board', { minimum, caller, audit, guard, … })`. The key is how the daemon half names its handler. */
export function route<const Key extends string>(key: Key, descriptor: WithoutPattern<RouteDescriptor>): RouteDecl<Key> {
  return Object.freeze({ ...descriptor, ...parseRouteKey(key), key });
}

export function socket<const Key extends string>(
  key: Key,
  descriptor: WithoutPattern<SocketDescriptor>,
): SocketDecl<Key> {
  return Object.freeze({ ...descriptor, ...parseRouteKey(key), key });
}

/** A member route (§7.1): the separate member table, never served to a device. */
export function memberRoute<const Key extends string>(
  key: Key,
  descriptor: WithoutPattern<MemberRouteDescriptor>,
): MemberRouteDecl<Key> {
  return Object.freeze({ ...descriptor, ...parseRouteKey(key), key });
}

export function verb<const Verb extends string>(verbLine: Verb, options: Omit<VerbDecl, 'verb'> = {}): VerbDecl<Verb> {
  return Object.freeze({ ...options, verb: verbLine });
}

export function tool<const Name extends string>(name: Name, descriptor: Omit<ToolDecl, 'name'>): ToolDecl<Name> {
  return Object.freeze({ ...descriptor, name });
}

export function screen<const Id extends string>(id: Id, options: Omit<ScreenDecl, 'id'>): ScreenDecl<Id> {
  return Object.freeze({ ...options, id });
}

export function panel<const Id extends string>(
  slot: SlotName,
  options: { readonly id: Id; readonly order: number },
): PanelDecl<Id> {
  return Object.freeze({ slot, id: options.id, order: options.order });
}

export function settingsTab<const Id extends string>(
  id: Id,
  options: Omit<SettingsTabDecl, 'id'>,
): SettingsTabDecl<Id> {
  return Object.freeze({ ...options, id });
}

/** `renderer('ask', { source: 'card' })` → key `ask:card`; `renderer('reference', { prefix: '&' })` → `reference:&`. */
export function renderer<const Source extends string>(
  kind: 'ask',
  options: { readonly source: Source },
): RendererDecl<`ask:${Source}`>;
export function renderer<const Prefix extends string>(
  kind: 'reference',
  options: { readonly prefix: Prefix },
): RendererDecl<`reference:${Prefix}`>;
export function renderer(
  kind: 'ask' | 'reference',
  options: { readonly source?: string; readonly prefix?: string },
): RendererDecl {
  return kind === 'ask'
    ? Object.freeze({ kind, source: options.source ?? '', key: `ask:${options.source ?? ''}` })
    : Object.freeze({ kind, prefix: options.prefix ?? '', key: `reference:${options.prefix ?? ''}` });
}

export function appAction<const Id extends string>(id: Id, options: Omit<AppActionDecl, 'id'>): AppActionDecl<Id> {
  return Object.freeze({ ...options, id });
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The one declaration (§3.3). Keeps every literal (route keys, tool names, hook names) so the halves are typed
 * against it. Checks identity at load; the generator's `manifest-match` and the plugin-graph checks do the rest.
 */
export function definePlugin<const M extends Manifest>(manifest: M): M {
  PluginIdSchema.parse(manifest.id);
  if (!SEMVER.test(manifest.version)) throw new TypeError(`plugin ${manifest.id}: version "${manifest.version}"`);
  if (manifest.api !== PLUGIN_API) throw new TypeError(`plugin ${manifest.id}: made for api ${manifest.api}`);
  const keys = new Set<string>();
  for (const decl of [...(manifest.actions?.routes ?? []), ...(manifest.actions?.sockets ?? [])]) {
    if (keys.has(decl.key)) throw new TypeError(`plugin ${manifest.id}: route ${decl.key} declared twice`);
    keys.add(decl.key);
  }
  return manifest;
}
