/**
 * THE REAL SETTINGS SHELL for a plugin's browser scene (r10 S5): the real `App` over ONE fake machine whose only plugin is the
 * one handed in, with the plugin's real settings-tab declarations (label, group, scope) and whatever bodies it supplies.
 * No daemon, no network: a fake transport answers the handful of reads the shell makes. A plugin's integration suite reaches
 * it as `@ferretry/app/testing/settings-shell` (a plugin never imports another package's source), and bundles it with
 * `sceneBuilder`. It exists so a settings page is measured at the panel width a person really gets (about 212px at a 768px
 * window, because the drawer, the side column and the settings list take the rest), not in a hand-built frame.
 *
 *   /d/ws/settings/<plugin>/<tab>      the tab, inside the shell
 *   ?theme=<family>-<mode>
 *
 * THE ONE RENDERER: `renderSettingsShellOf(surfaces)` mounts the real `App` over whatever surfaces it is handed; `renderSettingsShell`
 * builds the one-plugin list for a plugin's scene, and the app's own S12 shell scene (`integration/fixtures/settings-shell-scene.tsx`)
 * hands it the full catalog of every shipped plugin. Nothing else in the repo builds a fake machine for the shell.
 */

import { implementApp, type Manifest } from '@ferretry/kernel/manifest';
import { type ComponentType, type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { type DaemonlessPorts, registeredDaemonless } from '../../../src/connect/provides.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { generated } from '../../../src/generated/surfaces.ts';
import { DeviceLayoutStore } from '../../../src/layout/device-layout.ts';
import type { PasskeyHandler, PasskeyProvision } from '../../../src/passkey/passkey.ts';
import { ScrollMemory } from '../../../src/scroll/scroll-memory.ts';
import { App } from '../../../src/shell/app.tsx';
import { ShellContext } from '../../../src/shell/context.tsx';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { WithViewPlace } from '../../../src/shell/view-place.tsx';
import { memoryStore } from '../../../src/storage/records.ts';
import type { PlacedPanel } from '../../../src/testing/slot-panels.tsx';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { AddressTaker } from '../../../src/router/address.ts';
import { useDeviceControls } from '../../../src/compose/device-controls.ts';
import { DeviceProvider, type DeviceContextValue, NO_INSTALL_PROMPT } from '../../../src/shell/device-context.tsx';
import { HandOffs } from '../../../src/shell/hand-off.ts';
import {
  applyTextScale,
  applyThemeAxes,
  resolveThemeMode,
  ThemePreferenceStore,
} from '../../../src/theme/preferences.ts';
import { CORE, FakeTransport, inventoryOf, json } from '../../unit/client/fixtures.ts';

export interface SettingsShellScene {
  /** The plugin's real manifest (`manifest.ts`'s default export). */
  readonly manifest: unknown;
  /** One body per settings tab id the manifest declares. */
  readonly bodies: Readonly<Record<string, ComponentType>>;
  /** Where to draw; the page's `#root` by default. */
  readonly root?: HTMLElement | null;
}

const GRANTS = {
  capabilities: [
    {
      capability: 'fleet',
      use: true,
      configure: true,
      granted: { use: true, configure: true },
      useRefusal: 'granted',
      configureRefusal: 'granted',
      mayGrant: false,
      origin: 'default',
    },
    // Pairing too: Connector's tab asks `pairing` for its switch and approvals, and a machine that says nothing of it reads as undetermined.
    {
      capability: 'pairing',
      use: true,
      configure: true,
      granted: { use: true, configure: true },
      useRefusal: 'granted',
      configureRefusal: 'granted',
      mayGrant: false,
      origin: 'default',
    },
  ],
  governed: true,
  hostLocal: false,
  steppedUp: false,
};

/** The page's theme from `?theme=<family>-<mode>`, applied before anything draws. */
export function applySceneTheme(): URLSearchParams {
  const params = new URLSearchParams(window.location.search);
  document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
  return params;
}

/** The surface a plugin contributes to the fake machine: its manifest's real declarations with the bodies given. */
export function settingsSurface(manifest: Manifest, bodies: Readonly<Record<string, ComponentType>>): SurfaceEntry {
  return {
    id: manifest.id,
    title: manifest.title,
    core: false,
    contract: `h-${manifest.id}`,
    consumes: [],
    manifest,
    app: implementApp(manifest, { build: () => ({ screens: {}, settings: bodies }) as never }),
  } satisfies SurfaceEntry;
}

export function renderSettingsShell({
  manifest: given,
  bodies,
  root = document.getElementById('root'),
}: SettingsShellScene) {
  applySceneTheme();
  renderSettingsShellOf([...CORE, settingsSurface(given as Manifest, bodies)], {}, root);
}

export interface ShellOptions {
  /** The fake machine's answer to a request, asked BEFORE the defaults; `undefined` falls through to them. */
  readonly answer?:
    | ((request: TransportRequest) => TransportAnswer | undefined | Promise<TransportAnswer | undefined>)
    | undefined;
  /** The id this browser is paired under on the fake machine. */
  readonly deviceId?: string | undefined;
}

/** The real `App` over one fake machine whose plugins are `surfaces` (the core ones included by the caller). */
export function renderSettingsShellOf(
  surfaces: readonly SurfaceEntry[],
  options: ShellOptions = {},
  root: HTMLElement | null = document.getElementById('root'),
) {
  const transport = new FakeTransport(async (request: TransportRequest): Promise<TransportAnswer> => {
    const registered = await options.answer?.(request);
    if (registered !== undefined) return registered;
    if (request.path === '/v1/plugins') return json(inventoryOf(surfaces));
    if (request.path === '/v1/health') return json({ protocol: 1, version: '5.0.0' });
    if (request.path === '/v1/grants') return json(GRANTS);
    return json({ ok: true });
  });
  const handler: PasskeyHandler = {
    need: () => undefined,
    confirm: async () => true,
    ask: async () => false,
    focus: () => undefined,
    locked: () => [],
    subscribe: () => () => undefined,
  };
  const provision = { handler, Prompts: () => null } as unknown as PasskeyProvision;
  const list = new DaemonList({ storage: memoryStore(), now: () => 1 });
  list.add({
    daemon: 'ws',
    machine: 'workshop-host',
    deviceId: options.deviceId ?? 'dev',
    address: 'http://127.0.0.1:40245',
  });
  const runtime = new ShellRuntime({
    appVersion: '5.0.0',
    surfaces,
    daemons: list,
    connect: async () => transport,
    passkey: () => provision,
    daemonless: {
      views: registeredDaemonless(surfaces, {} as DaemonlessPorts).views,
      location: () => window.location.href,
    },
  });
  const storage = memoryStore();
  if (root !== null)
    createRoot(root).render(
      <App
        runtime={runtime}
        themes={new ThemePreferenceStore(storage)}
        layouts={new DeviceLayoutStore(storage)}
        browser={window}
        scroll={new ScrollMemory(null)}
      />,
    );
}

/**
 * FOR A SCENE THAT DRAWS A PAGE OVER ANOTHER PLUGIN'S REAL PANELS (a page that offers a slot, e.g. Codex's sign-in page
 * mounting Logins' panels). A plugin never imports another package's source, so the panel it needs comes from the app's
 * own registry (`generated/surfaces.ts`, what the shell loads) and is BUILT as the shell builds it, over the client given.
 * `WithSlotPanels` is the shell's slot machinery (`PanelSlot` → `PluginView`) over the panels a scene places in a slot, and
 * `noteClientDaemon` names the daemon a page's client talks to (`daemonOfClient`). Kept here, not in `./testing`: that
 * barrel carries the happy-dom harness, which a browser bundle cannot take.
 */
export { noteClientDaemon } from '../../../src/connect/daemon-of.ts';
export { WithAppHooks } from '../../../src/testing/app-hooks.tsx';
export { type PlacedPanel, WithSlotPanels } from '../../../src/testing/slot-panels.tsx';

/**
 * FOR A SCENE THAT DRAWS A FERRET'S TEXT THE WAY THE SHELL DOES (`ProseView`, which asks the shell what Conversation
 * provides as `shell.prose`): the shell's context over the registry's REAL halves, or over `none` (the shell's own Markdown,
 * a baseline). No router, no connection: `ProseView` reads the surfaces and the standing the viewing machine `daemon` has
 * for each, which here is `allowed` for every plugin unless `blocked` names it (a daemon whose inventory turned it off).
 */
export function WithRegisteredSurfaces({
  children,
  none = false,
  daemon = 'scene-machine',
  blocked = [],
}: {
  children: ReactNode;
  none?: boolean;
  daemon?: string;
  blocked?: readonly string[];
}) {
  const runtime = {
    surfaces: none ? [] : generated.surfaces,
    standing: (_daemon: string, id: string) =>
      blocked.includes(id) ? { state: 'blocked', reason: 'off' } : { state: 'allowed' },
    // No plugin's app hook is provided here: a surface that reads one (Board's, for the agenda) is drawn without it.
    appHook: (): unknown => undefined,
    subscribe: () => () => undefined,
  };
  return (
    <ShellContext.Provider value={{ runtime } as never}>
      <WithViewPlace place={{ daemon, machine: 'Scene machine' } as never}>{children}</WithViewPlace>
    </ShellContext.Provider>
  );
}

/** One panel a plugin REGISTERS, as the shell builds it over `client`, placed under the plugin's own id. */
export function registeredPanel(plugin: string, id: string, client: unknown): PlacedPanel {
  const half = generated.surfaces.find(entry => entry.id === plugin)?.app;
  const panels = half?.build?.({ client } as never) as unknown as
    | { readonly panels?: Readonly<Record<string, (props: Record<string, unknown>) => ReactNode>> }
    | undefined;
  const view = panels?.panels?.[id];
  if (view === undefined) throw new Error(`${plugin} registers no panel ${id}`);
  return { plugin, id, view };
}

/** One screen a plugin REGISTERS, as the shell builds it over `client` (a screen that reads its address is drawn under a router). */
export function registeredScreen(
  plugin: string,
  id: string,
  client: unknown,
): (props: Record<string, unknown>) => ReactNode {
  const half = generated.surfaces.find(entry => entry.id === plugin)?.app;
  const built = half?.build?.({ client } as never) as unknown as
    | { readonly screens?: Readonly<Record<string, (props: Record<string, unknown>) => ReactNode>> }
    | undefined;
  const view = built?.screens?.[id];
  if (view === undefined) throw new Error(`${plugin} registers no screen ${id}`);
  return view;
}

/**
 * A DEVICE CONTEXT FOR A SCENE THAT DRAWS ONE REAL PANEL OUTSIDE THE SHELL (r11 G2 review): the panel's own `useDeviceTheme` reads
 * a real `ThemePreferenceStore` (kept in memory, first look = `mode`), and a pick publishes the style, palette, mode and text
 * scale on `<html>` exactly as the shell root does (`applyThemeAxes`, `applyTextScale`), so the page restyles for real; the
 * device's motion pick is written as `<html data-motion="reduced">` the way the shell root does, so a motion pick takes effect.
 */
export function WithDeviceTheme({
  mode,
  children,
}: {
  readonly mode: 'light' | 'dark';
  readonly children: ReactNode;
}): ReactNode {
  const [device] = useState<DeviceContextValue>(() => {
    const theme = new ThemePreferenceStore(memoryStore());
    theme.setMode(mode);
    return {
      theme,
      systemDark: false,
      install: NO_INSTALL_PROMPT,
      address: new AddressTaker([]),
      handOffs: new HandOffs(() => undefined, { now: Date.now, after: () => {} }),
      daemons: new DaemonList({ storage: memoryStore(), now: () => 1 }),
    };
  });
  const preference = useSyncExternalStore(device.theme.subscribe, () => device.theme.snapshot());
  useEffect(() => {
    const root = document.documentElement;
    applyThemeAxes(root, preference, resolveThemeMode(preference.mode, false));
    applyTextScale(root, preference.textScale);
  }, [preference]);
  return (
    <DeviceProvider value={device}>
      <AppliedMotion />
      {children}
    </DeviceProvider>
  );
}

/** The shell root's `useAppliedMotion`, for a scene: the device's motion pick on `<html data-motion>`. */
function AppliedMotion(): null {
  const { device } = useDeviceControls();
  const motion = device.motion;
  useEffect(() => {
    const root = document.documentElement;
    if (motion === 'reduced') root.dataset.motion = 'reduced';
    else delete root.dataset.motion;
  }, [motion]);
  return null;
}
