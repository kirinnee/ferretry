import { skeletonSentence } from '@ferretry/kernel/contract';
import { Component, type ErrorInfo, type ReactNode, Suspense, useMemo } from 'react';
import type { PanelRef, ScreenRef } from '../layout/engine.ts';
import { useRouter } from '../router/router.tsx';
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
 * A view that throws while rendering is contained to its own box, and one that SUSPENDS (a lazy half's first draw) is
 * too: only its own box shows "Loading {title}…" until its chunk arrives, and the frame around it is never blanked (S10).
 */
export class ViewBoundary extends Component<
  { readonly title: string; readonly children: ReactNode },
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
    if (this.state.failed) return <ShellLine tone="warn">{this.props.title} stopped working on this screen.</ShellLine>;
    return <Suspense fallback={<ShellLine>Loading {this.props.title}…</ShellLine>}>{this.props.children}</Suspense>;
  }
}

type Section = 'screens' | 'panels' | 'settings' | 'renderers';

interface PluginViewProps {
  readonly daemon: string;
  readonly plugin: string;
  readonly section: Section;
  readonly id: string;
  readonly props: Record<string, unknown>;
}

export function PluginView({ daemon, plugin, section, id, props }: PluginViewProps) {
  const { runtime } = useShell();
  useRuntimeVersion(runtime);
  // Who is drawn here (§1.1): this plugin, on a daemon, with its own reach into every paired daemon (S2).
  const identity = useMemo(() => identityOf(runtime, plugin, 'daemon'), [runtime, plugin]);
  const title = runtime.titleOf(plugin);
  const blocked = runtime.blockedLine(daemon, plugin);
  if (blocked !== undefined) return <ShellLine tone="warn">{blocked}</ShellLine>;
  const half = runtime.half(daemon, plugin);
  if (half === undefined || half.kind === 'skeleton') return <ShellLine>{skeletonSentence(title)}</ShellLine>;
  if (half.kind === 'failed') return <ShellLine tone="warn">{title} could not start in this app.</ShellLine>;
  const view = half[section][id] as ((p: Record<string, unknown>) => ReactNode) | undefined;
  if (view === undefined) return <ShellLine>{skeletonSentence(title)}</ShellLine>;
  const Rendered = view;
  // Where the view is drawn (S1): ITS daemon's machine, feed and authority, never the selected daemon's.
  return (
    <ViewBoundary title={title}>
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
      <ViewBoundary title={runtime.titleOf(screen.plugin)}>
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
}: {
  readonly daemon: string | undefined;
  readonly screen: ScreenRef;
  readonly params: Readonly<Record<string, string>>;
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
  return <PluginView daemon={daemon} plugin={screen.plugin} section="screens" id={screen.id} props={{ params }} />;
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
}: {
  readonly daemon: string;
  readonly slot: string;
  readonly subject?: string;
  readonly props?: Readonly<Record<string, unknown>>;
}) {
  // Outside a shell (a plugin's own harness or suite) there is no layout, so no panel is placed.
  const shell = useOptionalShell();
  if (shell === null) return null;
  const panels: readonly PanelRef[] = shell.plan.panels(slot);
  if (panels.length === 0) return null;
  return (
    <div className="fy-slot" data-slot={slot}>
      {panels.map(panel => (
        <div key={`${panel.plugin}.${panel.id}`} className="fy-panel" data-panel={`${panel.plugin}.${panel.id}`}>
          <PluginView
            daemon={daemon}
            plugin={panel.plugin}
            section="panels"
            id={panel.id}
            props={subject === undefined ? { ...props } : { ...props, subject }}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Whether the layout places any panel in `slot` here: false outside a shell. A screen that offers a slot draws its own
 * fallback where no panel is placed (the composer its attach button, in a suite or a detached box).
 */
export function useSlotHasPanels(slot: string): boolean {
  const shell = useOptionalShell();
  return shell !== null && shell.plan.panels(slot).length > 0;
}
