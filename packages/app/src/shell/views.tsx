import { skeletonSentence } from '@ferretry/kernel/contract';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { PanelRef, ScreenRef } from '../layout/engine.ts';
import { useRuntimeVersion, useShell } from './context.tsx';

/**
 * WHERE PLUGIN VIEWS ARE DRAWN. Every plugin screen, panel and settings tab goes through {@link PluginView}, which
 * asks the runtime first: a blocked package shows its one line (§9.6), a skeleton half the skeleton sentence (§7),
 * a half whose build threw one line; only an allowed, built half's component renders. Every other plugin keeps
 * working whatever one of them does.
 */

/** One quiet line in place of a view. */
export function ShellLine({ children, tone = 'info' }: { readonly children: ReactNode; readonly tone?: 'info' | 'warn' }) {
  return (
    <p className={`fy-shell-line fy-shell-line--${tone}`} role="status">
      {children}
    </p>
  );
}

/** A view that throws while rendering is contained to its own box. */
class ViewBoundary extends Component<{ readonly title: string; readonly children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // Contained: the shell shows one line; the error is the plugin's to fix.
  }

  override render(): ReactNode {
    if (this.state.failed) return <ShellLine tone="warn">{this.props.title} stopped working on this screen.</ShellLine>;
    return this.props.children;
  }
}

type Section = 'screens' | 'panels' | 'settings';

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
  const title = runtime.titleOf(plugin);
  const blocked = runtime.blockedLine(daemon, plugin);
  if (blocked !== undefined) return <ShellLine tone="warn">{blocked}</ShellLine>;
  const half = runtime.half(daemon, plugin);
  if (half === undefined || half.kind === 'skeleton') return <ShellLine>{skeletonSentence(title)}</ShellLine>;
  if (half.kind === 'failed') return <ShellLine tone="warn">{title} could not start in this app.</ShellLine>;
  const view = half[section][id] as ((p: Record<string, unknown>) => ReactNode) | undefined;
  if (view === undefined) return <ShellLine>{skeletonSentence(title)}</ShellLine>;
  const Rendered = view;
  return (
    <ViewBoundary title={title}>
      <Rendered {...props} />
    </ViewBoundary>
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
  if (daemon === undefined) {
    // A daemon-less screen (an absolute path): it has no daemon to read its inventory from.
    return <ShellLine>{skeletonSentence(screen.label)}</ShellLine>;
  }
  return <PluginView daemon={daemon} plugin={screen.plugin} section="screens" id={screen.id} props={{ params }} />;
}

/** Every panel the layout places in one slot, for one daemon and one subject (a ferret, a card). */
export function PanelSlot({
  daemon,
  slot,
  subject,
}: {
  readonly daemon: string;
  readonly slot: string;
  readonly subject?: string;
}) {
  const { plan } = useShell();
  const panels: readonly PanelRef[] = plan.panels(slot);
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
            props={subject === undefined ? {} : { subject }}
          />
        </div>
      ))}
    </div>
  );
}
