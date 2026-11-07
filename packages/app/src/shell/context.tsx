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
import { type RouteTable, routeTable } from '../router/routes.ts';
import {
  applyTextScale,
  resolveThemeMode,
  type ThemePreference,
  type ThemePreferenceStore,
  themeAttribute,
} from '../theme/preferences.ts';
import type { ScrollMemory } from '../scroll/scroll-memory.ts';
import type { ShellRuntime } from './runtime.ts';

/** Everything the shell's components read: the runtime, the views, the route table, the layout in force. */
export interface ShellModel {
  readonly runtime: ShellRuntime;
  readonly views: Views;
  readonly routes: RouteTable;
  readonly layout: LayoutChoice;
  readonly plan: FramePlan;
  readonly viewport: Viewport;
  readonly themes: ThemePreferenceStore;
  /** This device's layout changes (`--device`), on top of the owner's layout. */
  readonly layouts: DeviceLayoutStore;
  /** Where each page was scrolled, per history entry (`fy:app:scroll`, this tab only). */
  readonly scroll: ScrollMemory;
}

const ShellContext = createContext<ShellModel | null>(null);

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
  readonly document: { readonly documentElement: HTMLElement };
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

/** Publishes the theme on the root: `data-theme="<family>-<mode>"`, the text scale, and the density. */
function useAppliedTheme(browser: ShellWindow, preference: ThemePreference, density: string): void {
  const dark = useMedia(browser, DARK_QUERY);
  useEffect(() => {
    const root = browser.document.documentElement;
    root.dataset.theme = themeAttribute(preference.family, resolveThemeMode(preference.mode, dark));
    root.dataset.density = density;
    applyTextScale(root, preference.textScale);
  }, [browser, dark, density, preference]);
}

export interface ShellProviderProps {
  readonly runtime: ShellRuntime;
  readonly themes: ThemePreferenceStore;
  /** This device's layout changes (`--device`, saved in this browser), on top of the owner's layout. */
  readonly layouts: DeviceLayoutStore;
  readonly browser: ShellWindow;
  readonly scroll: ScrollMemory;
  readonly children: ReactNode;
}

/**
 * The owner's layout from the selected daemon (the Layouts plugin), re-read on `layouts.changed` and whenever the
 * runtime changes (an inventory read can allow or block Layouts there). `undefined` with no daemon or no Layouts.
 */
function useOwnerLayout(runtime: ShellRuntime): Layout | undefined {
  const version = useRuntimeVersion(runtime);
  const selected = runtime.daemons.snapshot().selected;
  useEffect(() => {
    if (selected !== null) runtime.layouts.watch(selected);
  }, [runtime, selected, version]);
  return useSyncExternalStore(runtime.layouts.subscribe, () =>
    selected === null ? undefined : runtime.layouts.current(selected),
  );
}

export function ShellProvider({ runtime, themes, layouts, browser, scroll, children }: ShellProviderProps) {
  const phone = useMedia(browser, PHONE_QUERY);
  const preference = useSyncExternalStore(themes.subscribe, () => themes.snapshot());
  const overrides = useSyncExternalStore(layouts.subscribe, layouts.snapshot);
  const owner = useOwnerLayout(runtime);
  const views = useMemo(() => viewsOf(runtime.surfaces), [runtime]);
  const routes = useMemo(() => routeTable(views.screens.values()), [views]);
  const layout = useMemo(
    () => chooseLayout(layoutCandidates(owner, overrides), views.installed),
    [owner, overrides, views],
  );
  const viewport: Viewport = phone ? 'phone' : 'wide';
  const plan = useMemo(() => planFrame(resolveLayout(layout.layout, viewport), views), [layout, viewport, views]);
  useAppliedTheme(browser, preference, plan.density);
  const model = useMemo<ShellModel>(
    () => ({ runtime, views, routes, layout, plan, viewport, themes, layouts, scroll }),
    [runtime, views, routes, layout, plan, viewport, themes, layouts, scroll],
  );
  return <ShellContext.Provider value={model}>{children}</ShellContext.Provider>;
}
