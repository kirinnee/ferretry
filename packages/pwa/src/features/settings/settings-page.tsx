/**
 * The daemon-scoped Settings route surface.
 *
 * Preferences such as theme and density belong to the reader's browser, but
 * destinations that name daemon state (the Warden configuration) are built
 * from the explicit daemon id. That distinction lets this page be mounted for
 * any paired daemon without retaining a previous daemon's link.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type ReactNode, useMemo, useSyncExternalStore } from 'react';

import { type ThemeState, useTheme } from '../../hooks/use-theme.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonControlsStore, Density } from '../../lib/controls.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { CHAT_WIDTH_OPTIONS, ChatWidthControl } from '../../shell/chat-width-control.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { ThemeSettings } from '../../shell/theme-toggle.tsx';
import { DictationSettings, type DictationSettingsProps } from './dictation-settings.tsx';
import { MarkdownComposerSettings } from './markdown-composer-settings.tsx';
import { SETTINGS_DEFINITIONS, SETTINGS_LINKS, type SettingDefinition, type SettingId } from './settings-catalog.ts';

export const TEXT_SCALE_OPTIONS = [
  { id: 'default', label: 'Default', description: 'Use the interface’s designed size.' },
  { id: 'large', label: 'Large', description: '112% of default.' },
  { id: 'larger', label: 'Larger', description: '125% of default.' },
] as const;

export const DENSITY_OPTIONS: readonly {
  readonly id: Density;
  readonly label: string;
  readonly description: string;
}[] = [
  { id: 'full', label: 'Full', description: 'Show the available session detail.' },
  { id: 'compact', label: 'Compact', description: 'Keep rows easy to scan.' },
  { id: 'minimal', label: 'Minimal', description: 'Prioritise the session names.' },
] as const;

const defaultDensity = (): Density =>
  typeof window !== 'undefined' && window.matchMedia?.('(max-width: 768px)').matches ? 'compact' : 'full';

export interface SettingsSectionProps {
  readonly definition: SettingDefinition;
  readonly children: ReactNode;
}

export function SettingsSection({ definition, children }: SettingsSectionProps) {
  const headingId = `settings-${definition.id}-heading`;
  return (
    <section
      id={`settings-${definition.id}`}
      data-setting-id={definition.id}
      tabIndex={-1}
      className="kt-panel p-panel outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-labelledby={headingId}
    >
      <h2 id={headingId} className="m-0 text-title font-semibold text-fg">
        {definition.label}
      </h2>
      <p className="mt-1 text-ui leading-base text-muted">{definition.description}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function TextScaleControl({ theme }: { readonly theme: ThemeState }) {
  return (
    <div
      role="radiogroup"
      aria-label="Text size"
      aria-describedby={!theme.textScaleSupported ? 'text-scale-unsupported' : undefined}
      className="grid grid-cols-1 gap-2 sm:grid-cols-3"
    >
      {TEXT_SCALE_OPTIONS.map(option => {
        const checked = (theme.textScaleSupported ? theme.textScale : 'default') === option.id;
        return (
          <label
            key={option.id}
            className={cn(
              'flex min-h-[44px] min-w-0 cursor-pointer flex-col items-start justify-center rounded-control border px-control-x py-2 text-left transition-colors',
              'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
              checked
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-border bg-surface-2 text-fg hover:border-accent',
              !theme.textScaleSupported && 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              type="radio"
              name="text-scale"
              value={option.id}
              checked={checked}
              disabled={!theme.textScaleSupported}
              onChange={() => theme.setTextScale(option.id)}
              className="sr-only"
            />
            <span className="text-ui font-semibold">{option.label}</span>
            <span className="text-meta leading-tight text-muted">{option.description}</span>
          </label>
        );
      })}
    </div>
  );
}

export interface SettingsPageProps {
  /** The paired daemon whose Warden link this page exposes. */
  readonly daemonId: DaemonId;
  /** Reader-local controls; only device fields are edited here. */
  readonly controls: DaemonControlsStore;
  /** The daemon-scoped dictation surface: engine readiness, chord, enhancer. */
  readonly dictation: DictationSettingsProps;
  /** The daemon-aware notification host, supplied by the composition root. */
  readonly notifications?: ReactNode;
  /** Called for the header's in-app Back action. */
  readonly onNavigate?: (to: string) => void;
  readonly className?: string;
}

/**
 * One Settings implementation for desktop and narrow screens. Its single
 * scroll owner and `sm:` grids preserve the original 390px/1440px behavior:
 * controls stack touch-first on a phone and become three-column cards on wider
 * screens.
 */
export function SettingsPage({
  daemonId,
  controls,
  dictation,
  notifications,
  onNavigate,
  className,
}: SettingsPageProps) {
  const record = useSyncExternalStore(
    controls.subscribe,
    () => controls.snapshot(),
    () => controls.snapshot(),
  );
  const device = record.device;
  const density = device.density ?? defaultDensity();
  const theme = useTheme();

  const controlsById = useMemo<Record<SettingId, ReactNode>>(
    () => ({
      'text-size': (
        <>
          <TextScaleControl theme={theme} />
          {theme.textScaleSupported ? (
            <p className="mt-2 text-meta leading-base text-faint">
              Sizes never go below Default, so existing 44px touch targets are not reduced.
            </p>
          ) : (
            <p id="text-scale-unsupported" role="status" className="mt-2 text-ui leading-base text-warn">
              Text sizing is unavailable in this browser because it does not support percentage text adjustment. Browser
              and operating-system zoom still work.
            </p>
          )}
        </>
      ),
      density: (
        <>
          <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <legend className="sr-only">Dashboard density</legend>
            {DENSITY_OPTIONS.map(option => {
              const checked = density === option.id;
              return (
                <label
                  key={option.id}
                  className={cn(
                    'flex min-h-[44px] min-w-0 cursor-pointer flex-col items-start justify-center rounded-control border px-control-x py-2 text-left transition-colors',
                    'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
                    checked
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-border bg-surface-2 text-fg hover:border-accent',
                  )}
                >
                  <input
                    type="radio"
                    name="dashboard-density"
                    value={option.id}
                    checked={checked}
                    onChange={() => controls.setDeviceControls({ density: option.id })}
                    className="sr-only"
                  />
                  <span className="text-ui font-semibold">{option.label}</span>
                  <span className="text-meta leading-tight text-muted">{option.description}</span>
                </label>
              );
            })}
          </fieldset>
          {device.density === null && (
            <p className="mt-2 text-meta leading-base text-faint">
              Using the device default. Picking a level saves an explicit choice.
            </p>
          )}
        </>
      ),
      'chat-width': (
        <ChatWidthControl value={device.chatWidth} onChange={chatWidth => controls.setDeviceControls({ chatWidth })} />
      ),
      'composer-markdown': <MarkdownComposerSettings />,
      theme: <ThemeSettings theme={theme} />,
      dictation: <DictationSettings {...dictation} />,
      notifications: notifications ?? (
        <p role="status" className="m-0 text-ui leading-base text-muted">
          Notification delivery is unavailable until this page is composed with the paired daemon’s push-subscription
          host.
        </p>
      ),
    }),
    [controls, density, device.chatWidth, device.density, dictation, notifications, theme],
  );

  return (
    <main
      data-settings-scroller
      data-density={density}
      className={cn('h-full min-h-0 w-full overflow-y-auto overscroll-contain px-panel pb-4', className)}
    >
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3 py-2">
        <header className="flex min-w-0 flex-wrap items-center gap-2">
          <RouteLink
            to={`/d/${encodeURIComponent(daemonId)}`}
            onNavigate={onNavigate}
            aria-label="Back to sessions"
            title="All sessions"
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </RouteLink>
          <div className="min-w-0">
            <h1 className="m-0 font-display text-display font-bold tracking-display">Settings</h1>
            <p className="mt-0.5 text-ui text-muted">Appearance and dashboard detail for this browser.</p>
          </div>
        </header>

        {SETTINGS_DEFINITIONS.map(definition => (
          <SettingsSection key={definition.id} definition={definition}>
            {controlsById[definition.id]}
          </SettingsSection>
        ))}

        {SETTINGS_LINKS.map(link => (
          <section key={link.id} id={`settings-${link.id}`} className="kt-panel p-panel" aria-label={link.label}>
            <RouteLink
              to={link.href(daemonId)}
              onNavigate={onNavigate}
              className="group flex min-h-[44px] w-full items-center justify-between gap-2 text-left"
            >
              <span className="min-w-0">
                <span className="block text-title font-semibold text-fg group-hover:text-accent">{link.label}</span>
                <span className="mt-1 block text-ui leading-base text-muted">{link.description}</span>
              </span>
              <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-muted group-hover:text-accent" />
            </RouteLink>
          </section>
        ))}
      </div>
    </main>
  );
}

/** Kept exported for consumers that need the exact conversation-width contract. */
export { CHAT_WIDTH_OPTIONS };
