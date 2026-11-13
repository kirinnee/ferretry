import { Suspense, useMemo } from 'react';
import type { RegisteredBackgroundView } from '../connect/provides.ts';
import { useRuntimeVersion, useShell } from './context.tsx';
import { identityOf, WithPluginIdentity } from './plugin-identity.tsx';
import type { ShellRuntime } from './runtime.ts';
import { ViewBoundary } from './views.tsx';
import { WithViewPlace } from './view-place.tsx';

/**
 * THE FRAME'S BACKGROUND HOST (shell contract S5): every plugin's background views, each mounted ONCE PER PAIRED DAEMON
 * where the plugin may run — at the frame root, outside the router, so a watcher keeps running whatever page is open.
 * A view may render nothing (a watcher) or an overlay (a toast, a sheet).
 *
 * - **Background origin (MJ1).** A view is handed, as a prop, its plugin's client on that daemon in BACKGROUND passkey
 *   origin — the `background` entry of the one client cache — and its plugin identity is `place: 'background'`, whose
 *   `useEveryDaemon` rows carry background-origin clients too. So it reaches no ordinary-origin client by either route:
 *   a call to a locked machine waits for the unlock (or for that machine to be on screen) and never raises a prompt.
 * - **Standing is read here, at render.** The client comes from the cache's read-time standing check, so a plugin that is
 *   blocked, paused or unread on a daemon gets none and its view is not mounted; the same client object returns once it
 *   is allowed again, and a transport reconnect keeps it (the view does not remount for a reconnect's sake).
 * - **Contained.** Each view sits in its own `ViewBoundary` and `Suspense` (drawing nothing while a lazy chunk loads): one
 *   that throws costs only itself. It is drawn inside the view place of ITS daemon, with the same shell context a panel
 *   gets — it adds no authority a panel has not.
 */
export function BackgroundViews() {
  const { runtime } = useShell();
  useRuntimeVersion(runtime);
  const daemons = runtime.daemons.snapshot().daemons;
  return (
    <>
      {daemons.flatMap(paired =>
        runtime.backgroundViews.map(entry => (
          <BackgroundView
            key={`${paired.daemon}\u0000${entry.plugin}.${entry.id}`}
            runtime={runtime}
            daemon={paired.daemon}
            entry={entry}
          />
        )),
      )}
      {/* Where a link opens (S7): each machine's provided sheet, drawn once, in this same place. */}
      {daemons.map(paired => (
        <LinkSheet key={paired.daemon} runtime={runtime} daemon={paired.daemon} />
      ))}
    </>
  );
}

/**
 * One machine's link sheet (S7): the `sheet` of what Browsers provides for that machine, drawn ONCE at the frame root
 * (not by each link), in Browsers' background place — a sheet is an overlay, and nothing it sends raises a prompt.
 */
function LinkSheet({ runtime, daemon }: { readonly runtime: ShellRuntime; readonly daemon: string }) {
  const provision = runtime.linkProvision(daemon);
  const plugin = runtime.linkProvider();
  const identity = useMemo(
    () => (plugin === undefined ? undefined : identityOf(runtime, plugin, 'background')),
    [runtime, plugin],
  );
  if (provision === undefined || plugin === undefined || identity === undefined || provision.sheet == null) return null;
  return (
    <ViewBoundary title={runtime.titleOf(plugin)}>
      <WithPluginIdentity identity={identity}>
        <WithViewPlace place={runtime.place(daemon)}>
          <Suspense fallback={null}>{provision.sheet}</Suspense>
        </WithViewPlace>
      </WithPluginIdentity>
    </ViewBoundary>
  );
}

function BackgroundView({
  runtime,
  daemon,
  entry,
}: {
  readonly runtime: ShellRuntime;
  readonly daemon: string;
  readonly entry: RegisteredBackgroundView;
}) {
  const identity = useMemo(() => identityOf(runtime, entry.plugin, 'background'), [runtime, entry.plugin]);
  // The cache's background entry, only while the plugin is allowed on this daemon: none means nothing is mounted.
  const client = runtime.client(daemon, entry.plugin, 'background');
  if (client === undefined) return null;
  const View = entry.view;
  return (
    <ViewBoundary title={runtime.titleOf(entry.plugin)}>
      <WithPluginIdentity identity={identity}>
        <WithViewPlace place={runtime.place(daemon)}>
          <Suspense fallback={null}>
            <View daemon={daemon} client={client} />
          </Suspense>
        </WithViewPlace>
      </WithPluginIdentity>
    </ViewBoundary>
  );
}
