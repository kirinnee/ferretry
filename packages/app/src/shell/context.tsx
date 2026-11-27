import { createContext, type ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { type FramePlan, planFrame, type Views, viewsOf } from '../layout/engine.ts';
import type { DeviceLayoutStore } from '../layout/device-layout.ts';
import {
  chooseLayout,
  type Layout,
  type LayoutChoice,
  layoutCandidates,
  resolveLayout,
  type Viewport,
} from '../layout/layout.ts';
import { useDeviceControls } from '../compose/device-controls.ts';
import { type RouteTable, routeTable } from '../router/routes.ts';
import {
  applyTextScale,
  resolveThemeMode,
  type ThemePreference,
  type ThemePreferenceStore,
  applyThemeAxes,
  manifestHrefFor,
  MANIFEST_LINK_ID,
  themeColorFromComputedStyle,
} from '../theme/preferences.ts';
import { DEFAULT_PALETTE, DEFAULT_STYLE, isPaletteId, isStyleId, type PaletteId } from '../theme/catalog.ts';
import type { ScrollMemory } from '../scroll/scroll-memory.ts';
import { applyThemeItem, type ThemeItem } from '../theme/tokens.ts';
import type { OwnerLayout } from '../layout/daemon-layout.ts';
import type { ShellRuntime } from './runtime.ts';
import {
  DeviceProvider,
  type DeviceContextValue,
  type InstallPromptHolder,
  NO_INSTALL_PROMPT,
} from './device-context.tsx';

/** Everything the shell's components read: the runtime, the views, the route table, the layout in force. */
export interface ShellModel {
  readonly runtime: ShellRuntime;
  readonly views: Views;
  readonly routes: RouteTable;
  readonly layout: LayoutChoice;
  /** The owner's layout from the selected daemon (Layouts), before this device's overrides; `undefined` without one. */
  readonly owner: Layout | undefined;
  readonly plan: FramePlan;
  readonly viewport: Viewport;
  readonly themes: ThemePreferenceStore;
  /** This device's layout changes (`--device`), on top of the owner's layout. */
  readonly layouts: DeviceLayoutStore;
  /** Where each page was scrolled, per history entry (`fy:app:scroll`, this tab only). */
  readonly scroll: ScrollMemory;
  /**
   * Whether `plugin` is offered ON `daemon` (that machine has not turned it off): what a machine's own nav, finder and
   * side column ask. `views` is the fleet-wide listing (a surface stays while ANY machine has it on) for device-wide
   * places only. With no daemon there is no machine to ask, so it is `true`.
   */
  readonly offeredOn: (daemon: string | undefined, plugin: string) => boolean;
}

export const ShellContext = createContext<ShellModel | null>(null);

/** The shell model, or `null` outside a shell (a harness, a test): a reader there follows the plain href. */
export function useOptionalShell(): ShellModel | null {
  return useContext(ShellContext);
}

/**
 * Draws its children with NO shell: every reader of the shell model below (the daemon-client hooks, a panel slot, a
 * renderer view, the layout hooks) finds `null` and does what it does outside a shell. A daemon-less screen is drawn
 * here, so no hook or component of this package can reach a paired daemon from it, by a daemon id read from anywhere.
 */
export function WithoutShell({ children }: { readonly children: ReactNode }) {
  return <ShellContext.Provider value={null}>{children}</ShellContext.Provider>;
}

/** The app build this browser runs; `undefined` outside a shell (a harness, a test), where nothing says which build it is. */
export function useAppVersion(): string | undefined {
  return useOptionalShell()?.runtime.appVersion;
}

export function useShell(): ShellModel {
  const model = useContext(ShellContext);
  if (model === null) throw new Error('useShell must be rendered inside ShellProvider');
  return model;
}

/** Re-renders on every runtime change (an inventory read, a pairing, a block). */
export function useRuntimeVersion(runtime: ShellRuntime): number {
  return useSyncExternalStore(runtime.subscribe, runtime.version, runtime.version);
}

/** The window seam the shell needs: media queries and the document root. Tests pass a fake. */
export interface ShellWindow {
  matchMedia(query: string): {
    matches: boolean;
    addEventListener(type: 'change', fn: () => void): void;
    removeEventListener(type: 'change', fn: () => void): void;
  };
  readonly document: { readonly documentElement: HTMLElement } & Partial<
    Pick<Document, 'getElementById' | 'querySelector' | 'createElement' | 'head'>
  >;
}

const PHONE_QUERY = '(max-width: 767px)';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function useMedia(browser: ShellWindow, query: string): boolean {
  const [matches, setMatches] = useState(() => browser.matchMedia(query).matches);
  useEffect(() => {
    const list = browser.matchMedia(query);
    const update = (): void => setMatches(list.matches);
    list.addEventListener('change', update);
    update();
    return () => list.removeEventListener('change', update);
  }, [browser, query]);
  return matches;
}

/**
 * Publishes the theme on the root. The style, palette, mode and text scale are THIS device's (a device setting, §5.2); the
 * owner's theme from the daemon (`fy theme use`) lays its light and dark tokens over them, and names a style or a palette
 * of its own only when it says so.
 */
/**
 * The window colour for the OS chrome and the themed install manifest, as today's `use-theme.ts` set them: the ONE
 * identified manifest link is repointed (never a second link), and one `theme-color` meta, created on demand, takes
 * the computed `--bg` (never a colour map in TypeScript). A document without these (a test's) is left alone.
 */
function applyWindowColour(document: ShellWindow['document'], palette: PaletteId, resolved: 'light' | 'dark'): void {
  const link = document.getElementById?.(MANIFEST_LINK_ID);
  if (link) {
    const current = link.getAttribute('href') ?? '';
    const next = manifestHrefFor(current, palette, resolved);
    // Only on a real change: assigning the same href re-fetches the manifest in some browsers.
    if (next !== current) link.setAttribute('href', next);
  }
  if (document.querySelector === undefined || document.createElement === undefined || document.head === undefined)
    return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  const color = themeColorFromComputedStyle(document.documentElement);
  if (color && meta.content !== color) meta.content = color;
}

function useAppliedTheme(
  browser: ShellWindow,
  preference: ThemePreference,
  dark: boolean,
  density: string,
  ownerTheme: ThemeItem | undefined,
): void {
  useEffect(() => {
    const root = browser.document.documentElement;
    const resolved = resolveThemeMode(preference.mode, dark);
    // The owner's theme item may name a style and/or a palette: then it wins over this device's pick for that axis. An
    // id with no pack is the default look, as everywhere (the saved item is left as it is).
    const look = {
      ...preference,
      style:
        ownerTheme?.style === undefined
          ? preference.style
          : isStyleId(ownerTheme.style)
            ? ownerTheme.style
            : DEFAULT_STYLE,
      palette:
        ownerTheme?.palette === undefined
          ? preference.palette
          : isPaletteId(ownerTheme.palette)
            ? ownerTheme.palette
            : DEFAULT_PALETTE,
    };
    applyThemeAxes(root, look, resolved);
    root.dataset.density = density;
    applyTextScale(root, preference.textScale);
    applyThemeItem(root, ownerTheme, resolved);
    applyWindowColour(browser.document, look.palette, resolved);
  }, [browser, dark, density, preference, ownerTheme]);
}

/** Settings › This device › Motion: `reduced` stills every animation (`<html data-motion="reduced">`, styles/index.css). */
function useAppliedMotion(browser: ShellWindow): void {
  const { device } = useDeviceControls();
  const motion = device.motion;
  useEffect(() => {
    const root = browser.document.documentElement;
    if (motion === 'reduced') root.dataset.motion = 'reduced';
    else delete root.dataset.motion;
  }, [browser, motion]);
}

export interface ShellProviderProps {
  readonly runtime: ShellRuntime;
  readonly themes: ThemePreferenceStore;
  /** This device's layout changes (`--device`, saved in this browser), on top of the owner's layout. */
  readonly layouts: DeviceLayoutStore;
  readonly browser: ShellWindow;
  readonly scroll: ScrollMemory;
  /** The install-as-app prompt the browser offered (S13); none until then. */
  readonly install?: InstallPromptHolder;
  readonly children: ReactNode;
}

/**
 * The owner's layout from the selected daemon (the Layouts plugin), re-read on `layouts.changed` and whenever the
 * runtime changes (an inventory read can allow or block Layouts there). `undefined` with no daemon or no Layouts.
 */
function useOwnerLayout(runtime: ShellRuntime): OwnerLayout | undefined {
  const version = useRuntimeVersion(runtime);
  const selected = runtime.daemons.snapshot().selected;
  // `version` is the point: every runtime change (an inventory read that allows or blocks Layouts) re-checks the watch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on each runtime change, not only on `selected`
  useEffect(() => {
    if (selected !== null) runtime.layouts.watch(selected);
  }, [runtime, selected, version]);
  return useSyncExternalStore(runtime.layouts.subscribe, () =>
    selected === null ? undefined : runtime.layouts.current(selected),
  );
}

export function ShellProvider({
  runtime,
  themes,
  layouts,
  browser,
  scroll,
  install = NO_INSTALL_PROMPT,
  children,
}: ShellProviderProps) {
  const phone = useMedia(browser, PHONE_QUERY);
  const dark = useMedia(browser, DARK_QUERY);
  const preference = useSyncExternalStore(themes.subscribe, () => themes.snapshot());
  const overrides = useSyncExternalStore(layouts.subscribe, layouts.snapshot);
  const served = useOwnerLayout(runtime);
  const owner = served?.layout;
  // What the owner is offered (nav, panels, the finder) leaves out a surface every paired daemon has turned off; the
  // route table and the layout check keep every compiled surface, so a deep link still says "off" and a layout still checks.
  // The key spells out each machine's own listing too, so a machine turning a surface off re-draws what is offered ON that machine.
  const listedKey = useSyncExternalStore(runtime.subscribe, () =>
    [
      runtime
        .listedSurfaces()
        .map(entry => entry.id)
        .join(','),
      ...runtime.daemons.snapshot().daemons.map(
        paired =>
          `${paired.daemon}=${runtime
            .listedSurfaces(paired.daemon)
            .map(entry => entry.id)
            .join(',')}`,
      ),
    ].join(';'),
  );
  const everything = useMemo(() => viewsOf(runtime.surfaces), [runtime]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `listedKey` is the listing's value; it rebuilds the views when a surface goes on or off.
  const views = useMemo<Views>(() => {
    const listed = runtime.listedSurfaces();
    return listed.length === runtime.surfaces.length
      ? everything
      : { ...viewsOf(listed), installed: everything.installed };
  }, [runtime, everything, listedKey]);
  const routes = useMemo(() => routeTable(everything.screens.values()), [everything]);
  const layout = useMemo(
    () => chooseLayout(layoutCandidates(owner, overrides), views.installed),
    [owner, overrides, views],
  );
  const viewport: Viewport = phone ? 'phone' : 'wide';
  const plan = useMemo(() => planFrame(resolveLayout(layout.layout, viewport), views), [layout, viewport, views]);
  useAppliedTheme(browser, preference, dark, plan.density, served?.theme);
  useAppliedMotion(browser);
  // The device context sits ABOVE the shell context, so `WithoutShell` (which hides only the shell) never hides it.
  const device = useMemo<DeviceContextValue>(
    () => ({
      theme: themes,
      systemDark: dark,
      install,
      address: runtime.address,
      handOffs: runtime.handOffs,
      daemons: { snapshot: runtime.daemons.snapshot, subscribe: runtime.daemons.subscribe },
    }),
    [themes, dark, install, runtime],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `listedKey` is the listing's value; `offeredOn` reads it live, so a new key makes a new model.
  const model = useMemo<ShellModel>(
    () => ({
      runtime,
      views,
      routes,
      layout,
      owner,
      plan,
      viewport,
      themes,
      layouts,
      scroll,
      offeredOn: (daemon, plugin) =>
        daemon === undefined || runtime.listedSurfaces(daemon).some(entry => entry.id === plugin),
    }),
    [runtime, views, routes, layout, owner, plan, viewport, themes, layouts, scroll, listedKey],
  );
  return (
    <DeviceProvider value={device}>
      <ShellContext.Provider value={model}>{children}</ShellContext.Provider>
    </DeviceProvider>
  );
}
