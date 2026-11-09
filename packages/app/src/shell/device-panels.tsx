import { Suspense, useCallback, useMemo, useSyncExternalStore } from 'react';
import type { DevicePanelSlot, NavBadge, RegisteredDevicePanel } from '../connect/provides.ts';
import { useRuntimeVersion, useShell, WithoutShell } from './context.tsx';
import { identityOf, WithPluginIdentity } from './plugin-identity.tsx';
import type { ShellRuntime } from './runtime.ts';
import { ViewBoundary } from './views.tsx';

/**
 * DEVICE-LEVEL PANELS AND NAV COUNTS (shell contract S4). A `device.settings` panel (Settings › Appearance) and a `nav`
 * panel (Needs you, under the nav entries) belong to THIS device, not to one machine: each is drawn ONCE, with no daemon
 * and no client, under `WithoutShell`, inside its plugin identity (`place: 'device-panel'`, with `reach`). A panel that
 * needs machines lists them with `useEveryDaemon`, one row per machine, each row writing only through its own client — so
 * a write can never go to "whichever machine is selected", and the nav can never show one machine's blocked or paused line.
 */

/** The panels the layout places in a device-level slot, in the layout's order, each in its own box. */
export function DevicePanels({ slot }: { readonly slot: DevicePanelSlot }) {
  const { runtime, plan } = useShell();
  useRuntimeVersion(runtime);
  const drawn = plan.panels(slot).flatMap(panel => {
    const entry = runtime.devicePanel(slot, panel.plugin, panel.id);
    return entry === undefined ? [] : [entry];
  });
  if (drawn.length === 0) return null;
  return (
    <div className="fy-slot fy-slot--device" data-device-slot={slot}>
      {drawn.map(entry => (
        <div key={`${entry.plugin}.${entry.id}`} className="fy-panel" data-panel={`${entry.plugin}.${entry.id}`}>
          <DevicePanel runtime={runtime} entry={entry} />
        </div>
      ))}
    </div>
  );
}

function DevicePanel({ runtime, entry }: { readonly runtime: ShellRuntime; readonly entry: RegisteredDevicePanel }) {
  const identity = useMemo(() => identityOf(runtime, entry.plugin, 'device-panel'), [runtime, entry.plugin]);
  const View = entry.view;
  return (
    <ViewBoundary title={runtime.titleOf(entry.plugin)}>
      <WithPluginIdentity identity={identity}>
        <WithoutShell>
          <Suspense fallback={null}>
            <View />
          </Suspense>
        </WithoutShell>
      </WithPluginIdentity>
    </ViewBoundary>
  );
}

/** The most a pill shows before it says "99+": it never widens its entry. */
const BADGE_CAP = 99;

const countOf = (badge: NavBadge): number => {
  try {
    const n = badge.count();
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
};

const subscribeTo = (badge: NavBadge, changed: () => void): (() => void) => {
  try {
    return badge.subscribe(changed);
  } catch {
    return () => {};
  }
};

/**
 * The count on a nav entry, SUMMED across every machine where the plugin is allowed (MA5). It re-reads when the runtime
 * changes (a machine comes, goes, locks or is blocked) and when any machine's provider says it changed; a sum of 0 draws
 * nothing. The pill is decoration; a screen reader hears "N open <entry> items".
 */
export function NavCount({
  plugin,
  screen,
  label,
}: {
  readonly plugin: string;
  readonly screen: string;
  readonly label: string;
}) {
  const { runtime } = useShell();
  const version = useRuntimeVersion(runtime);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` re-reads the providers when a machine comes or goes.
  const subscribe = useCallback(
    (changed: () => void) => {
      const offs = runtime.navBadges(plugin, screen).map(badge => subscribeTo(badge, changed));
      return () => {
        for (const off of offs) off();
      };
    },
    [runtime, plugin, screen, version],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` re-reads the providers when a machine comes or goes.
  const read = useCallback(
    () => runtime.navBadges(plugin, screen).reduce((sum, badge) => sum + countOf(badge), 0),
    [runtime, plugin, screen, version],
  );
  const total = useSyncExternalStore(subscribe, read, read);
  if (total === 0) return null;
  return (
    <span className="fy-nav__badge" data-count={total}>
      <span aria-hidden="true">{total > BADGE_CAP ? `${BADGE_CAP}+` : total}</span>
      <span className="sr-only">{`${total} open ${label} items`}</span>
    </span>
  );
}
