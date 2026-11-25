import { BackgroundViews } from './background.tsx';
import { DeviceViews } from './device-views.tsx';
import { PhoneTitleBar } from './phone-title-bar.tsx';
import { useCallback, useMemo, useRef, useState } from 'react';
import { DEFAULT_LAYOUT } from '../layout/layout.ts';
import { CommandBar } from '../ui/command-bar.tsx';
import { useAppViewport } from '../ui/hooks/use-app-viewport.ts';
import { buildPluginCommandSources, deviceLayoutSource, placeSource, settingsSource } from './command-sources.ts';
import { useScreenHref } from '../router/screen-href.ts';
import { ChatMenu } from './chat-menu.tsx';
import { BottomNav } from './drawer-nav.tsx';
import { Drawer, useDrawerShortcut } from './drawer.tsx';
import { useFindShortcut } from './drawer-find.tsx';
import { RightSide } from './side-column.tsx';
import { isChatRoute, routeDaemon } from './nav-targets.ts';
import type { Route } from '../router/routes.ts';
import { useRouter } from '../router/router.tsx';
import { useRuntimeVersion, useShell } from './context.tsx';
import { DaemonHomePage, DaemonListPage, DaemonSettingsPage, DeviceSettingsPage, NotFoundPage } from './pages.tsx';
import { PageScrollRegion } from '../scroll/page-scroll-region.tsx';
import { FrameRootContext } from './frame-root.tsx';
import { NameThisMachine } from './name-machine.tsx';
import { PasskeyMount } from './passkey-mount.tsx';
import { MachineStopPage } from './machine-stop-page.tsx';
import { stopOf } from './machine-stop.ts';
import { ScreenView } from './views.tsx';

/**
 * THE FRAME (§5.2): the shell's slots, placed by the layout: the left drawer (find, destinations, the list slot; an overlay on a phone) and, on a phone, the `bottom` bar; `main` (one screen at a time, by the router), `side` (wide screens, when the layout asks). Nothing
 * in the frame is a feature: every entry is a plugin's screen, or one of the shell's own items.
 */

function Main({ route }: { readonly route: Route }) {
  switch (route.kind) {
    case 'home':
      return <DaemonListPage />;
    case 'device-settings':
      return <DeviceSettingsPage />;
    case 'daemon-home':
      return <DaemonHomePage daemon={route.daemon} />;
    case 'daemon-settings':
      return (
        <DaemonSettingsPage
          daemon={route.daemon}
          {...(route.tab === undefined ? {} : { tab: route.tab })}
          {...(route.tabId === undefined ? {} : { tabId: route.tabId })}
        />
      );
    case 'screen':
      return <ScreenView daemon={route.daemon} screen={route.screen} params={route.params} />;
    case 'not-found':
      return <NotFoundPage />;
  }
}

/** The command bar with the shell's own sources (places, this device's layout commands) and the plugins' entries. */
function ShellCommandBar(props: {
  readonly daemon: string | undefined;
  readonly open: boolean;
  readonly focusSignal: number;
  readonly onClose: () => void;
}) {
  const { runtime, views, routes, owner, layouts, offeredOn } = useShell();
  const router = useRouter();
  const { route } = router;
  // The ferret whose page this is, for the entries that are about "this ferret" (Board's, S-0449).
  const ferret = route.kind === 'screen' ? route.params.ferret : undefined;
  // `useScreenHref` answers a fresh function every render with the same answers; the sources read the latest one.
  const screenHrefOf = useScreenHref();
  const screenHrefRef = useRef(screenHrefOf);
  screenHrefRef.current = screenHrefOf;
  // The bar follows which plugins the machine allows: opened right after a page loads, it is open BEFORE the machine has
  // said which plugins are on, and sources built then would have no plugin to ask and never be built again.
  useRuntimeVersion(runtime);
  const allowed =
    props.daemon === undefined
      ? ''
      : runtime.surfaces.map(entry => runtime.standing(props.daemon as string, entry.id).state).join(',');
  const daemons = runtime.daemons.snapshot().daemons;
  // A plugin source that was waiting on its daemon asks for a new listing by bumping this.
  const [answers, setAnswers] = useState(0);
  const changed = useCallback(() => setAnswers(current => current + 1), []);
  const daemon = props.daemon;
  // Built once per daemon and plugin set (a source holds what its daemon last answered), and only while the bar is open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `allowed` rebuilds the sources when a plugin becomes allowed.
  const pluginSources = useMemo(
    () =>
      daemon === undefined || !props.open
        ? []
        : buildPluginCommandSources({
            surfaces: runtime.listedSurfaces(daemon),
            daemon,
            clientOf: plugin => runtime.client(daemon, plugin),
            navigate: href => router.navigate(href),
            screenHref: (...address) => screenHrefRef.current(...address),
            changed,
            ferret,
            appHook: name => runtime.appHook(daemon, name),
          }),
    [daemon, props.open, runtime, router, changed, ferret, allowed],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `answers` re-lists when a plugin source's answer arrives.
  const sources = useMemo(
    () => [
      placeSource({
        daemons,
        daemon,
        // A machine's own places are the ones THAT machine has on; a device-wide place (a `/` path) is no machine's.
        screens: [...views.screens.values()].filter(
          screen => screen.path.startsWith('/') || offeredOn(daemon, screen.plugin),
        ),
        routes,
        navigate: href => router.navigate(href),
      }),
      settingsSource({ daemon, surfaces: runtime.listedSurfaces(daemon), navigate: href => router.navigate(href) }),
      deviceLayoutSource(owner ?? DEFAULT_LAYOUT, layouts),
      ...pluginSources,
    ],
    [daemons, daemon, views, routes, router, owner, layouts, pluginSources, answers, runtime, offeredOn],
  );
  return <CommandBar open={props.open} focusSignal={props.focusSignal} onClose={props.onClose} sources={sources} />;
}

export function Frame() {
  const { runtime, plan, scroll } = useShell();
  useRuntimeVersion(runtime);
  const { route, entryKey } = useRouter();
  const daemon = routeDaemon(route);
  // A ferret's own page: the chat, whose top chrome is one slim row (shell.css `[data-chat-chrome]`, chat-menu.tsx).
  // A machine this browser cannot use at all (refused, unreadable, needs an update, not paired…) is ONE full page, not an empty shell.
  const stop = daemon === undefined ? undefined : stopOf(runtime, daemon);
  const chat = isChatRoute(route) && stop === undefined;
  // A screen that declares `chrome: 'none'` (first-run setup), or the stop page, is drawn alone: no drawer, bars, side column or command bar.
  const bare = stop !== undefined || (route.kind === 'screen' && route.screen.chrome === 'none');
  const [bar, setBar] = useState({ open: false, signal: 0 });
  // Ctrl-K opens nothing on a chrome-less screen (no bar is drawn, so it must not wait open for the next screen).
  const openBar = useCallback(
    () => (bare ? undefined : setBar(current => ({ open: true, signal: current.signal + 1 }))),
    [bare],
  );
  const closeBar = useCallback(() => setBar(current => ({ ...current, open: false })), []);
  const findRef = useRef<HTMLButtonElement | null>(null);
  useFindShortcut(findRef, openBar);
  // Cmd/Ctrl+B has no drawer to toggle on a chrome-less screen, and must not change the remembered rail setting there.
  useDrawerShortcut(!bare);
  // The visible height (`--app-h`) and the keyboard-open attribute every screen lays itself out by, as today.
  useAppViewport();
  // The frame root, handed to the shell's own overlays (the machine picker, S10) so they draw above every plugin sheet.
  const [frameRoot, setFrameRoot] = useState<HTMLElement | null>(null);
  return (
    <FrameRootContext.Provider value={frameRoot}>
      <div
        ref={setFrameRoot}
        className={`fy-frame${plan.nav.side === 'bottom' && !bare ? ' fy-frame--nav-bottom' : ''}`}
        data-chrome={bare ? 'none' : undefined}
        data-chat-chrome={chat ? '' : undefined}
        data-layout={plan.layoutId}
      >
        {bare ? null : (
          <Drawer
            daemon={daemon}
            navDaemon={daemon ?? runtime.daemons.snapshot().selected ?? undefined}
            route={route}
            findRef={findRef}
            onFind={openBar}
          />
        )}
        <div className="fy-body">
          {bare ? null : <PhoneTitleBar />}
          {/* THE STATUS STRIP: where the views mounted at the frame root draw what they draw IN FLOW — a line a watcher
      says ("Couldn't reach it through the relay…"), a banner. They sit here, a row above the
      columns, never as a child of the frame's own row: a line placed beside the body is a COLUMN of the frame and takes its
      width from the page (the agenda's item column fell from v4's ~680px to 350px at 1280). An overlay a view draws is
      fixed or portalled and does not care where it is mounted; an empty strip takes no room. */}
          <div className="fy-status" data-slot="status">
            {/* Every plugin's device views, once each (S3): the one taker of its keyed fragments, over every machine. */}
            <DeviceViews />
            {/* Every plugin's background views, once per paired daemon where it may run (S5): watchers and overlays. */}
            <BackgroundViews />
            {/* A machine a pairing just made, and that has no name of the owner's, offers to be named (skippable). */}
            {/* Not on a chrome-less screen: first-run setup owns the whole frame and draws its own Machine-name page,
      so the strip would be a second name form above it, pushing Back/Next off screen. */}
            {daemon !== undefined && !bare && runtime.daemons.namePending(daemon) ? (
              <NameThisMachine key={daemon} daemon={daemon} />
            ) : null}
          </div>
          <div className="fy-columns">
            <main className="fy-main" data-slot="main">
              {chat ? <ChatMenu /> : null}
              <PageScrollRegion entryKey={entryKey} memory={scroll}>
                {stop === undefined ? <Main route={route} /> : <MachineStopPage daemon={daemon} facts={stop} />}
              </PageScrollRegion>
            </main>
            {!bare ? <RightSide daemon={daemon} route={route} /> : null}
          </div>
          {plan.nav.side === 'bottom' && !bare ? (
            <BottomNav daemon={daemon ?? runtime.daemons.snapshot().selected ?? undefined} />
          ) : null}
        </div>
        {bare ? null : (
          <ShellCommandBar
            daemon={daemon ?? runtime.daemons.snapshot().selected ?? undefined}
            open={bar.open}
            focusSignal={bar.signal}
            onClose={closeBar}
          />
        )}
        {/* One passkey prompt for the whole app (Access's): any daemon call refused for want of an unlock or a step-up
      raises it, and only the machine on screen may raise a background one (G95, G105). */}
        <PasskeyMount onScreen={runtime.passkeyOnScreen.chosen() ?? daemon ?? runtime.daemons.snapshot().selected} />
      </div>
    </FrameRootContext.Provider>
  );
}
