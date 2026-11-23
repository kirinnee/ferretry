import { skeletonSentence } from '@ferretry/kernel/contract';
import { Component, type ErrorInfo, type ReactNode, Suspense, useMemo, useRef, useSyncExternalStore } from 'react';
import type { PanelRef, ScreenRef } from '../layout/engine.ts';
import { useRouter } from '../router/router.tsx';
import { Loading, useHeldLoading } from '../ui/loading.tsx';
import { useOptionalShell, useRuntimeVersion, useShell, WithoutShell } from './context.tsx';
import { useDaemonChooser } from './daemon-chooser.tsx';
import { identityOf, WithPluginIdentity } from './plugin-identity.tsx';
import { WithViewPlace } from './view-place.tsx';

/**
 * WHERE PLUGIN VIEWS ARE DRAWN. Every plugin screen, panel and settings tab goes through {@link PluginView}, which
 * asks the runtime first: a blocked package shows its one line (§9.6), a skeleton half the skeleton sentence (§7),
 * a half whose build threw one line; only an allowed, built half's component renders. Every other plugin keeps
 * working whatever one of them does.
 */

/** One quiet line in place of a view. */
export function ShellLine({
  children,
  tone = 'info',
}: {
  readonly children: ReactNode;
  readonly tone?: 'info' | 'warn';
}) {
  return (
    <p className={`fy-shell-line fy-shell-line--${tone}`} role="status">
      {children}
    </p>
  );
}

/**
 * WHAT A VIEW SHOWS WHILE IT WAITS (the one loading system, `ui/loading.tsx`). A page-sized view (a screen, a settings
 * tab) is the whole area the person is looking at, so it draws the page animation — once, because only one is on
 * screen. Anything smaller (a panel in a slot, a renderer) draws NOTHING of its own and tells the shell's one top bar
 * instead: ten panels waiting on the same daemon are one bar, never ten stacked lines.
 */
function Waiting({ page, label }: { readonly page: boolean; readonly label: string }) {
  return <Loading className="fy-loading--fill" kind={page ? 'page' : 'bar'} label={label} />;
}

/**
 * A view that throws while rendering is contained to its own box, and one that SUSPENDS (a lazy half's first draw) is
 * too: only its own box shows "Loading {title}…" until its chunk arrives, and the frame around it is never blanked (S10).
 */
export class ViewBoundary extends Component<
  {
    readonly title: string;
    readonly children: ReactNode;
    readonly fallback?: ReactNode;
    /** Whether this view is page-sized, which decides how it waits ({@link Waiting}). */
    readonly page?: boolean;
    /** A panel of a slot: the SLOT holds one `Suspense` for all of them, so none draws before the rest (one readiness gate). */
    readonly shared?: boolean;
  },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // Contained: the shell shows one line; the error is the plugin's to fix.
  }

  override render(): ReactNode {
    const { fallback } = this.props;
    if (this.state.failed) {
      if (fallback !== undefined) return <>{fallback}</>;
      return <ShellLine tone="warn">{this.props.title} stopped working on this screen.</ShellLine>;
    }
    // A panel of a slot is drawn under the slot's own Suspense: the slot is one readiness gate, so no panel draws before the rest.
    if (this.props.shared === true) return this.props.children;
    return (
      <Suspense
        fallback={
          fallback === undefined ? (
            <Waiting page={this.props.page === true} label={`Loading ${this.props.title}…`} />
          ) : (
            fallback
          )
        }
      >
        {this.props.children}
      </Suspense>
    );
  }
}

type Section = 'screens' | 'panels' | 'settings' | 'renderers';

interface PluginViewProps {
  readonly daemon: string;
  readonly plugin: string;
  readonly section: Section;
  readonly id: string;
  readonly props: Record<string, unknown>;
  /**
   * What stands in when the view cannot be drawn (blocked, not built, failed to start, throws, still loading) instead of
   * the shell's one line: for a view that REPLACES something the host can draw itself, which stays readable.
   */
  readonly fallback?: ReactNode;
  /** Drawn as one of a slot's panels, under the slot's own single `Suspense` ({@link PanelSlot}). */
  readonly shared?: boolean;
  /**
   * Drawn BESIDE the page (the side column's screen), not as the page: it waits on the shell's one top bar and never draws a
   * page loader of its own, because the page itself already stands under the one centred loader.
   */
  readonly aside?: boolean;
}

export function PluginView({ daemon, plugin, section, id, props, fallback, shared, aside }: PluginViewProps) {
  const { runtime } = useShell();
  useRuntimeVersion(runtime);
  // Who is drawn here (§1.1): this plugin, on a daemon, with its own reach into every paired daemon (S2).
  const identity = useMemo(() => identityOf(runtime, plugin, 'daemon'), [runtime, plugin]);
  const title = runtime.titleOf(plugin);
  const stood = (line: ReactNode): ReactNode => (fallback === undefined ? line : fallback);
  const blocked = runtime.blockedLine(daemon, plugin);
  const page = aside !== true && (section === 'screens' || section === 'settings');
  // Still waiting for the daemon to say what it offers: a loader, not a sentence per view (a page of panels was a stack of
  // them). Held steady (`useHeldLoading`): never shown for a fast answer, never blinked off and on for a slow one.
  const waiting = blocked !== undefined && runtime.waiting(daemon, plugin);
  const said = useRef(blocked);
  if (waiting) said.current = blocked;
  const held = useHeldLoading(waiting);
  if (held) return stood(<Waiting page={page} label={said.current ?? 'Loading…'} />);
  if (blocked !== undefined) return stood(<ShellLine tone="warn">{blocked}</ShellLine>);
  const half = runtime.half(daemon, plugin);
  if (half === undefined || half.kind === 'skeleton') return stood(<ShellLine>{skeletonSentence(title)}</ShellLine>);
  if (half.kind === 'failed') return stood(<ShellLine tone="warn">{title} could not start in this app.</ShellLine>);
  const view = half[section][id] as ((p: Record<string, unknown>) => ReactNode) | undefined;
  if (view === undefined) return stood(<ShellLine>{skeletonSentence(title)}</ShellLine>);
  const Rendered = view;
  // Where the view is drawn (S1): ITS daemon's machine, feed and authority, never the selected daemon's.
  return (
    <ViewBoundary title={title} fallback={fallback} page={page} shared={shared === true}>
      <WithPluginIdentity identity={identity}>
        <WithViewPlace place={runtime.place(daemon)}>
          <Rendered {...props} />
        </WithViewPlace>
      </WithPluginIdentity>
    </ViewBoundary>
  );
}

/**
 * A DAEMON-LESS SCREEN (an absolute path: a share link's landing page, first-run setup, the page a pairing link opens).
 * It is drawn with the route's parameters, the router's `navigate` and the address read on demand — and no daemon
 * client: it is never given a default daemon, the first, or the last used (`DaemonlessScreenProps` has no field for
 * one). A plugin that gave no view for it draws the skeleton line.
 *
 * The props are not the only way to a daemon: the shell context is another. The view is drawn under {@link WithoutShell},
 * so `usePairedDaemons`, `useAppHook`, `PanelSlot`, `RendererView` and every other reader of the shell find none
 * and answer as they do outside a shell (nothing listed, nothing drawn). Its plugin identity has NO reach, so
 * `useEveryDaemon` answers `[]` there (MA4).
 */
function DaemonlessScreen({
  screen,
  params,
}: {
  readonly screen: ScreenRef;
  readonly params: Readonly<Record<string, string>>;
}) {
  const { runtime } = useShell();
  const router = useRouter();
  const identity = useMemo(
    () => identityOf(runtime, screen.plugin, 'daemonless', screen.id),
    [runtime, screen.plugin, screen.id],
  );
  const { chooseDaemon, picker } = useDaemonChooser(screen.plugin);
  const View = runtime.daemonlessView(screen.plugin, screen.id);
  if (View === undefined) return <ShellLine>{skeletonSentence(screen.label)}</ShellLine>;
  return (
    <>
      <ViewBoundary title={runtime.titleOf(screen.plugin)} page>
        <WithPluginIdentity identity={identity}>
          <WithoutShell>
            <View params={params} navigate={router.navigate} location={runtime.location} chooseDaemon={chooseDaemon} />
          </WithoutShell>
        </WithPluginIdentity>
      </ViewBoundary>
      {picker}
    </>
  );
}

export function ScreenView({
  daemon,
  screen,
  params,
  aside = false,
}: {
  readonly daemon: string | undefined;
  readonly screen: ScreenRef;
  readonly params: Readonly<Record<string, string>>;
  /** Drawn beside the page (the side column), so it waits on the top bar, not a second page loader. */
  readonly aside?: boolean;
}) {
  const daemonless = screen.path.startsWith('/');
  // A daemon-less screen is drawn without a daemon and ONLY without one: never under a `/d/<daemon>/` prefix.
  if (daemon === undefined) {
    return daemonless ? (
      <DaemonlessScreen key={`${screen.plugin}.${screen.id}`} screen={screen} params={params} />
    ) : (
      <ShellLine>{skeletonSentence(screen.label)}</ShellLine>
    );
  }
  if (daemonless) return <ShellLine>{skeletonSentence(screen.label)}</ShellLine>;
  return (
    <PluginView
      daemon={daemon}
      plugin={screen.plugin}
      section="screens"
      id={screen.id}
      props={{ params }}
      aside={aside}
    />
  );
}

/**
 * Every panel the layout places in one slot, for one daemon and one subject (a ferret, a card).
 *
 * A slot a plugin screen OFFERS (`<plugin>.<name>`) may take `props`: the data and callbacks that plugin's contract
 * declares for it, handed to every panel mounted there next to the `subject`. The shell does not read them.
 */
export function PanelSlot({
  daemon,
  slot,
  subject,
  props,
  phone,
  include,
}: {
  readonly daemon: string;
  readonly slot: string;
  readonly subject?: string;
  readonly props?: Readonly<Record<string, unknown>>;
  /** Draws only the panels this accepts: a host that splits one slot across two places (the composer's row and its status line). */
  readonly include?: (panel: PanelRef) => boolean;
  /**
   * On a phone the slot shows ONE panel at a time, full width (`ferret-workspace.tsx`). `active` is the panel on show
   * (`<plugin>.<id>`), or none while another tab (the chat) is; every panel stays mounted, only the active one is drawn,
   * so a terminal keeps its stream while another tab is open. `labelledBy` names the chip each panel answers to.
   */
  readonly phone?: {
    readonly active: string | undefined;
    readonly labelledBy: (panel: string) => string;
  };
}) {
  // Outside a shell (a plugin's own harness or suite) there is no layout, so no panel is placed.
  const shell = useOptionalShell();
  if (shell === null) return null;
  const placed: readonly PanelRef[] = shell.plan.panels(slot);
  const panels = include === undefined ? placed : placed.filter(include);
  if (panels.length === 0) return null;
  return (
    <div className="fy-slot" data-slot={slot} data-phone-active={phone?.active}>
      {/* ONE readiness gate for the whole slot: a panel whose view is still arriving holds the others back, so the slot
          draws once, together, under the one bar — never panel by panel. */}
      <Suspense fallback={<Loading kind="bar" label={`Loading ${slot}…`} />}>
        {panels.map(panel => (
          <div
            key={`${panel.plugin}.${panel.id}`}
            className="fy-panel"
            data-panel={`${panel.plugin}.${panel.id}`}
            {...(phone === undefined
              ? {}
              : {
                  role: 'tabpanel',
                  'aria-labelledby': phone.labelledBy(`${panel.plugin}.${panel.id}`),
                  'data-phone-shown': phone.active === `${panel.plugin}.${panel.id}` ? '' : undefined,
                })}
          >
            <PluginView
              daemon={daemon}
              plugin={panel.plugin}
              section="panels"
              id={panel.id}
              props={subject === undefined ? { ...props } : { ...props, subject }}
              shared
            />
          </div>
        ))}
      </Suspense>
    </div>
  );
}

/**
 * A BODY THE PANELS OF A SLOT MAY REPLACE: the host's own `fallback`, or — where a layout places panels in `slot` —
 * what they draw instead. The panels are NESTED in layout order, with no wrapper around any of them: the first is
 * handed the second as its `fallback` prop (and the last the host's), so a panel that does not recognise what it was
 * given returns `fallback` as it is. A panel that cannot be drawn (blocked, not built, throws, still loading) leaves
 * the next one in its place, and the host's body at the end, so what the slot replaces stays readable. No shell, no
 * panel: just `fallback`.
 */
export function PanelReplace({
  daemon,
  slot,
  subject,
  props,
  fallback,
}: {
  readonly daemon: string;
  readonly slot: string;
  readonly subject?: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly fallback: ReactNode;
}) {
  const panels = useSlotPanels(slot);
  const drawn = panels.reduceRight<ReactNode>(
    (inner, panel) => (
      <PluginView
        daemon={daemon}
        fallback={inner}
        id={panel.id}
        key={`${panel.plugin}.${panel.id}`}
        plugin={panel.plugin}
        props={subject === undefined ? { ...props, fallback: inner } : { ...props, subject, fallback: inner }}
        section="panels"
      />
    ),
    fallback,
  );
  return <>{drawn}</>;
}

/** The panels the layout places in `slot` here, in order; none outside a shell. */
export function useSlotPanels(slot: string): readonly PanelRef[] {
  const shell = useOptionalShell();
  return shell === null ? NO_PANELS : shell.plan.panels(slot);
}
const NO_PANELS: readonly PanelRef[] = [];

/**
 * Whether the layout places any panel in `slot` here: false outside a shell. A screen that offers a slot draws its own
 * fallback where no panel is placed (the composer its attach button, in a suite or a detached box).
 */
export function useSlotHasPanels(slot: string): boolean {
  const shell = useOptionalShell();
  return shell !== null && shell.plan.panels(slot).length > 0;
}

const NEVER_CHANGES = () => () => undefined;
const NO_VERSION = () => 0;

/**
 * Whether the layout places a panel in `slot` AND its plugin may run on `daemon` (not off, missing, paused or needing an
 * update there): for an OPTIONAL row or toolbar slot, where the shell's one "X is off on this daemon" line under every
 * row would be noise, not information. Re-reads when the runtime changes (an inventory read that allows or blocks the
 * plugin). False outside a shell. A screen that WANTS the blocked line uses {@link useSlotHasPanels} and `PanelSlot`.
 */
export function useSlotHasUsablePanels(daemon: string, slot: string): boolean {
  const shell = useOptionalShell();
  useSyncExternalStore(shell?.runtime.subscribe ?? NEVER_CHANGES, shell?.runtime.version ?? NO_VERSION);
  if (shell === null) return false;
  const { runtime, plan } = shell;
  return plan.panels(slot).some(panel => runtime.blockedLine(daemon, panel.plugin) === undefined);
}
