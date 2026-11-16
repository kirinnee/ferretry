/**
 * One feature's slice of a plugin's manifest, in the shape every plugin shares: `manifestFragment({ routes, ui, … })`.
 *
 * A plugin keeps a folder of fragments (`manifest/actions/NN-<feature>.actions.ts`), the generator
 * (`scripts/gen/registries.ts`) lists them into the git-ignored `manifest/generated/actions.ts`, and the plugin's
 * `manifest.ts` spreads that, so a feature adds a file and no manifest literal is edited. The merged order is the file
 * names sorted as plain strings, and a list's order is part of its package's contract hash, so the numeric prefix keeps
 * the entries in the order the manifest first declared them.
 *
 * A fragment names only the sections it contributes; every other section is an empty list, so a merged list is always
 * whole. Every literal is kept (route keys, tool names, verb lines, panel ids) so the merged manifest types the halves
 * exactly as one literal would have.
 */
import type { EventDef } from '../contract/define.ts';
import type {
  AppActionDecl,
  HookOffer,
  HookTake,
  LayoutDecl,
  MemberRouteDecl,
  PanelDecl,
  RendererDecl,
  RouteDecl,
  ScreenDecl,
  SettingsTabDecl,
  SocketDecl,
  ToolDecl,
  VerbDecl,
} from './types.ts';

/** The list sections of a manifest a fragment may contribute to, shaped as the manifest groups them. */
export interface FragmentParts {
  readonly routes?: readonly RouteDecl[];
  readonly sockets?: readonly SocketDecl[];
  readonly memberRoutes?: readonly MemberRouteDecl[];
  readonly agentTools?: readonly ToolDecl[];
  readonly cli?: readonly VerbDecl[];
  readonly app?: readonly AppActionDecl[];
  readonly ui?: {
    readonly screens?: readonly ScreenDecl[];
    readonly panels?: readonly PanelDecl[];
    readonly settings?: readonly SettingsTabDecl[];
    readonly renderers?: readonly RendererDecl[];
    readonly layouts?: readonly LayoutDecl[];
    readonly themes?: readonly LayoutDecl[];
  };
  readonly hooks?: {
    readonly takes?: readonly HookTake[];
    readonly offers?: readonly HookOffer[];
  };
  readonly data?: {
    readonly publishes?: readonly EventDef[];
    readonly subscribes?: readonly EventDef[];
  };
}

/** A section a fragment named keeps its literal type; one it did not name is the empty list. */
type Section<Parts, Key extends PropertyKey> = Parts extends { readonly [K in Key]: infer List } ? List : readonly [];
/** A group (`ui`, `hooks`, `data`) a fragment named, or none. */
type Group<Parts, Name extends 'ui' | 'hooks' | 'data'> = Parts extends { readonly [K in Name]: infer Sections }
  ? Sections
  : Record<never, never>;

/** What `manifestFragment` returns: every section of {@link FragmentParts}, each whole. */
export interface ManifestFragment<Parts extends FragmentParts> {
  readonly routes: Section<Parts, 'routes'>;
  readonly sockets: Section<Parts, 'sockets'>;
  readonly memberRoutes: Section<Parts, 'memberRoutes'>;
  readonly agentTools: Section<Parts, 'agentTools'>;
  readonly cli: Section<Parts, 'cli'>;
  readonly app: Section<Parts, 'app'>;
  readonly ui: {
    readonly screens: Section<Group<Parts, 'ui'>, 'screens'>;
    readonly panels: Section<Group<Parts, 'ui'>, 'panels'>;
    readonly settings: Section<Group<Parts, 'ui'>, 'settings'>;
    readonly renderers: Section<Group<Parts, 'ui'>, 'renderers'>;
    readonly layouts: Section<Group<Parts, 'ui'>, 'layouts'>;
    readonly themes: Section<Group<Parts, 'ui'>, 'themes'>;
  };
  readonly hooks: {
    readonly takes: Section<Group<Parts, 'hooks'>, 'takes'>;
    readonly offers: Section<Group<Parts, 'hooks'>, 'offers'>;
  };
  readonly data: {
    readonly publishes: Section<Group<Parts, 'data'>, 'publishes'>;
    readonly subscribes: Section<Group<Parts, 'data'>, 'subscribes'>;
  };
}

const none = <List>(): List => [] as unknown as List;

/** `Parts` with every key `Shape` does not name turned into `never`, so a misspelt key is an error and a right one is kept. */
type Known<Parts, Shape> = { readonly [K in keyof Parts]: K extends keyof Shape ? Parts[K] : never };

/**
 * The typo guard. With a bare `Parts` an excess-property check fires only when NO key matches, so `{ routes, agentTool }`
 * would compile and the misspelt section be dropped, type and runtime. Checking each level's keys against
 * {@link FragmentParts} catches it at the top and inside `ui`, `hooks` and `data`, and leaves every literal as written.
 */
type Exact<Parts extends FragmentParts> = Known<Parts, FragmentParts> & {
  readonly ui?: Known<NonNullable<Parts['ui']>, NonNullable<FragmentParts['ui']>>;
  readonly hooks?: Known<NonNullable<Parts['hooks']>, NonNullable<FragmentParts['hooks']>>;
  readonly data?: Known<NonNullable<Parts['data']>, NonNullable<FragmentParts['data']>>;
};

/**
 * One feature's slice of the manifest; a section it does not declare is empty. The cast is the one place the declared
 * parts meet the type that says "named sections keep their literal, the rest are `readonly []`": each branch below is that.
 */
export function manifestFragment<const Parts extends FragmentParts>(
  parts: Parts & Exact<Parts>,
): ManifestFragment<Parts> {
  const { ui, hooks, data } = parts;
  const fragment = {
    routes: parts.routes ?? none(),
    sockets: parts.sockets ?? none(),
    memberRoutes: parts.memberRoutes ?? none(),
    agentTools: parts.agentTools ?? none(),
    cli: parts.cli ?? none(),
    app: parts.app ?? none(),
    ui: {
      screens: ui?.screens ?? none(),
      panels: ui?.panels ?? none(),
      settings: ui?.settings ?? none(),
      renderers: ui?.renderers ?? none(),
      layouts: ui?.layouts ?? none(),
      themes: ui?.themes ?? none(),
    },
    hooks: { takes: hooks?.takes ?? none(), offers: hooks?.offers ?? none() },
    data: { publishes: data?.publishes ?? none(), subscribes: data?.subscribes ?? none() },
  };
  return fragment as unknown as ManifestFragment<Parts>;
}
