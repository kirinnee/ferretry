import { Suspense, useMemo } from 'react';
import type { RegisteredDeviceView } from '../connect/provides.ts';
import { useRouter } from '../router/router.tsx';
import { useShell, WithoutShell } from './context.tsx';
import { identityOf, WithPluginIdentity } from './plugin-identity.tsx';
import type { ShellRuntime } from './runtime.ts';
import { ViewBoundary } from './views.tsx';

/**
 * THE DEVICE-VIEW HOST (shell contract S3, MA2): every plugin's device views, each mounted ONCE at the frame root —
 * inside the router's provider and outside its routes, whether or not a machine is paired. A device view is where a
 * keyed fragment is taken (one taker, so the N per-daemon halves never race for a link) and where v4 ran its
 * once-over-every-machine readers.
 *
 * Each is drawn inside its own `ViewBoundary` (a throw costs only that view), under `WithoutShell` (so `useAppHook`,
 * `PanelSlot` and every reader of the shell answer as outside one — no daemon ARGUMENT reaches a machine) and inside its
 * plugin identity (`place: 'device'`, with `reach`): machines come only through `useEveryDaemon`. Each has its own
 * `Suspense` (drawing nothing while it loads), so a lazily loaded device view never holds up the frame.
 */
export function DeviceViews() {
  const { runtime } = useShell();
  const { navigate } = useRouter();
  return (
    <>
      {runtime.deviceViews.map(entry => (
        <DeviceView key={`${entry.plugin}.${entry.id}`} runtime={runtime} entry={entry} navigate={navigate} />
      ))}
    </>
  );
}

function DeviceView({
  runtime,
  entry,
  navigate,
}: {
  readonly runtime: ShellRuntime;
  readonly entry: RegisteredDeviceView;
  readonly navigate: ReturnType<typeof useRouter>['navigate'];
}) {
  const identity = useMemo(() => identityOf(runtime, entry.plugin, 'device'), [runtime, entry.plugin]);
  const View = entry.view;
  return (
    <ViewBoundary title={runtime.titleOf(entry.plugin)}>
      <WithPluginIdentity identity={identity}>
        <WithoutShell>
          <Suspense fallback={null}>
            <View navigate={navigate} />
          </Suspense>
        </WithoutShell>
      </WithPluginIdentity>
    </ViewBoundary>
  );
}
