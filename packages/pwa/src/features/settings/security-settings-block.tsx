/**
 * THE SECURITY SETTINGS BLOCK: the six knobs one machine keeps for the unlock, the per-act passkey
 * confirmation, a device key and an unused device (`docs/design/zero-trust.md` B6).
 *
 * ## EVERY SETTING SHOWS ITS VALUE AND ITS BOUNDS
 *
 * The bounds are the protocol's own (`SECURITY_SETTING_BOUNDS`), so the sentence a person reads and the
 * number the machine refuses can never disagree. A number outside them is not sent: the Save button
 * stays off and one sentence says the range.
 *
 * ## A CHANGE THAT WOULD BE REFUSED IS NOT OFFERED
 *
 * Tightening is allowed from a paired device with a passkey confirmation, which the carrier raises by
 * itself when the machine asks. LOOSENING is allowed only at the machine, so when this caller may not
 * (`view.mayWiden`) the loosening direction is switched off and ONE sentence names the command to run
 * there. Nothing is drawn that would only fail on press.
 *
 * ## EVERY FAILURE IS ONE SENTENCE
 *
 * No status, code or error name reaches the screen; see `securityFailureSentence`.
 */

import {
  isSecuritySwitch,
  SECURITY_SETTING_BOUNDS,
  type SecuritySettingField,
  type SecuritySwitchField,
  type SecuritySettingsPatch,
  type SecuritySettingsView,
  widensSecurity,
} from '@ferretry/protocol';
import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  boundsSentence,
  changeSecuritySettings,
  DAMAGED_SETTINGS_SENTENCE,
  describeSettingValue,
  devicesExpiringSentence,
  fetchSecuritySettings,
  type NumericSecuritySetting,
  parseSettingDraft,
  SECURITY_LOAD_FAILURE,
  SECURITY_SETTING_COPY,
  type SecuritySettingsClient,
  securityFailureSentence,
  widenAtMachineSentence,
} from '../../lib/security-settings-client.ts';
import { cn } from '../../lib/class-names.ts';

type SecuritySettingsClientFactory = (connection: DaemonConnection) => Promise<SecuritySettingsClient>;

/**
 * The order the design lists them in: each switch is followed by the number it governs. The change
 * confirmation window is shown only while the machine asks per act, because with it off the number
 * governs nothing a person could see.
 */
const rowsFor = (view: SecuritySettingsView): readonly SecuritySettingField[] => [
  'unlockOnOpen',
  'unlockValidityHours',
  'stepUpOnActions',
  ...(view.settings.stepUpOnActions ? (['stepUpWindowMinutes'] as const) : []),
  'deviceKeyRotationDays',
  'idleExpiryDays',
];

const ERROR_TONE = 'rounded-control border border-err-border bg-err-bg px-2 py-1 text-err';
const LIMIT_TONE = 'rounded-control border border-border bg-surface-2 px-2 py-1 text-muted';

interface NumberRowProps {
  readonly field: NumericSecuritySetting;
  readonly view: SecuritySettingsView;
  readonly draft: string | undefined;
  readonly busy: boolean;
  readonly onDraft: (draft: string) => void;
  readonly onSave: (value: number) => void;
}

/** One numeric setting: its value, its bounds, and a field with a Save that appears once it differs. */
function NumberRow({ field, view, draft, busy, onDraft, onSave }: NumberRowProps) {
  const inputId = useId();
  const noteId = useId();
  const copy = SECURITY_SETTING_COPY[field];
  const bounds = SECURITY_SETTING_BOUNDS[field];
  const current = view.settings[field];
  const dirty = draft !== undefined && draft !== String(current);
  const parsed = draft === undefined ? null : parseSettingDraft(field, draft);
  const outOfBounds = dirty && draft !== undefined ? boundsSentence(field, draft) : null;
  const widens = parsed !== null && widensSecurity(field, current, parsed);
  const blocked = widens && !view.mayWiden;
  const note = outOfBounds ?? (blocked ? widenAtMachineSentence(view.widenCommand) : null);
  return (
    <div className="min-w-0 border-t border-border-soft py-2 first:border-t-0" data-security-setting={field}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
        <label htmlFor={inputId} className="min-w-0 text-ui font-semibold text-fg">
          {copy.label}
        </label>
        <span className="text-ui text-fg" data-security-value={field}>
          {describeSettingValue(field, current)}
        </span>
      </div>
      <p className="m-0 text-meta leading-base text-muted">{copy.explanation}</p>
      <p className="m-0 text-meta leading-base text-muted" data-security-bounds={field}>
        {`Allowed: ${bounds.min} to ${describeSettingValue(field, bounds.max)}.`}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={bounds.min}
          max={bounds.max}
          step={1}
          value={draft ?? String(current)}
          disabled={busy}
          aria-describedby={note === null ? undefined : noteId}
          aria-invalid={outOfBounds === null ? undefined : true}
          data-security-input={field}
          onChange={event => onDraft(event.currentTarget.value)}
          className="kt-input !min-h-[44px] w-24 min-w-0"
        />
        {dirty ? (
          <button
            type="button"
            className="kt-btn min-h-[44px]"
            data-variant="primary"
            data-security-save={field}
            disabled={busy || parsed === null || blocked}
            onClick={() => {
              if (parsed !== null) onSave(parsed);
            }}
          >
            Save
          </button>
        ) : null}
      </div>
      {note === null ? null : (
        <p
          id={noteId}
          className={cn('m-0 mt-1 text-meta leading-base', outOfBounds === null ? LIMIT_TONE : ERROR_TONE)}
          data-security-note={field}
        >
          {note}
        </p>
      )}
    </div>
  );
}

interface SwitchRowProps {
  readonly field: SecuritySwitchField;
  readonly view: SecuritySettingsView;
  readonly busy: boolean;
  readonly onSave: (value: boolean) => void;
}

/** A switch. Turning it on tightens; turning it off loosens, so it is dead without `mayWiden`. */
function SwitchRow({ field, view, busy, onSave }: SwitchRowProps) {
  const noteId = useId();
  const copy = SECURITY_SETTING_COPY[field];
  const on = view.settings[field];
  const dead = on && !view.mayWiden;
  return (
    <div className="min-w-0 border-t border-border-soft py-2 first:border-t-0" data-security-setting={field}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-describedby={dead ? noteId : undefined}
        disabled={busy || dead}
        data-security-switch={field}
        onClick={() => onSave(!on)}
        className={cn(
          'flex min-h-[44px] w-full items-center justify-between gap-3 rounded-control border px-control-x py-2 text-left transition-colors',
          on ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2',
          busy || dead ? 'cursor-not-allowed opacity-70' : 'hover:border-accent',
        )}
      >
        <span className="min-w-0">
          <span className={cn('block text-ui font-semibold', on ? 'text-accent' : 'text-fg')}>{copy.label}</span>
          <span className="block text-meta leading-base text-muted">{copy.explanation}</span>
        </span>
        <span className="shrink-0 text-ui text-fg" data-security-value={field}>
          {on ? 'On' : 'Off'}
        </span>
      </button>
      {dead ? (
        <p id={noteId} className={cn('m-0 mt-1 text-meta leading-base', LIMIT_TONE)} data-security-note={field}>
          {widenAtMachineSentence(view.widenCommand)}
        </p>
      ) : null}
    </div>
  );
}

type Loaded =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly client: SecuritySettingsClient; readonly view: SecuritySettingsView };

export interface SecuritySettingsBlockProps {
  readonly connection: DaemonConnection;
  readonly createClient: SecuritySettingsClientFactory;
}

/** The live block for one machine. Reads once, never polls, and sends only the field that changed. */
export function SecuritySettingsBlock({ connection, createClient }: SecuritySettingsBlockProps) {
  const headingId = useId();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [drafts, setDrafts] = useState<Readonly<Partial<Record<NumericSecuritySetting, string>>>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoaded({ kind: 'loading' });
    setDrafts({});
    setFailure(null);
    setNotice(null);
    void createClient(connection)
      .then(async client => ({ client, view: await fetchSecuritySettings(client) }))
      .then(
        ({ client, view }) => {
          if (current) setLoaded({ kind: 'ready', client, view });
        },
        () => {
          if (current) setLoaded({ kind: 'failed' });
        },
      );
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  if (loaded.kind !== 'ready')
    return (
      <section
        className="kt-panel p-panel"
        role="status"
        aria-label="Security settings"
        data-security-settings-state={loaded.kind}
      >
        <p className="m-0 text-cell leading-base text-muted">
          {loaded.kind === 'loading' ? 'Reading this machine’s security settings…' : SECURITY_LOAD_FAILURE}
        </p>
      </section>
    );

  const { client, view } = loaded;

  const save = async (patch: SecuritySettingsPatch, field: SecuritySettingField): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const change = await changeSecuritySettings(client, patch);
      setLoaded({ kind: 'ready', client, view: change.view });
      setDrafts(({ [field as NumericSecuritySetting]: _saved, ...rest }) => rest);
      const copy = SECURITY_SETTING_COPY[field];
      const value = change.view.settings[field];
      const now =
        typeof value === 'boolean'
          ? value
            ? 'on'
            : 'off'
          : describeSettingValue(field as NumericSecuritySetting, value);
      setNotice(
        [`${copy.label}: now ${now}.`, devicesExpiringSentence(change.devicesExpiring)]
          .filter((sentence): sentence is string => sentence !== null)
          .join(' '),
      );
    } catch (reason) {
      setFailure(securityFailureSentence(reason, view.widenCommand));
    }
    setBusy(false);
  };

  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-2 p-panel"
      aria-labelledby={headingId}
      data-security-settings=""
    >
      <h3 id={headingId} className="m-0 flex items-center gap-1.5 text-row font-semibold text-fg">
        <SlidersHorizontal size={16} className="text-accent" aria-hidden="true" />
        Security settings
      </h3>
      {view.source === 'damaged' ? (
        <p role="alert" className={cn('m-0 text-meta leading-base', ERROR_TONE)} data-security-damaged="">
          {DAMAGED_SETTINGS_SENTENCE}
        </p>
      ) : null}
      <div className="flex min-w-0 flex-col">
        {rowsFor(view).map(field =>
          isSecuritySwitch(field) ? (
            <SwitchRow
              key={field}
              field={field}
              view={view}
              busy={busy}
              onSave={value => void save({ [field]: value }, field)}
            />
          ) : (
            <NumberRow
              key={field}
              field={field}
              view={view}
              draft={drafts[field]}
              busy={busy}
              onDraft={draft => setDrafts(current => ({ ...current, [field]: draft }))}
              onSave={value => void save({ [field]: value }, field)}
            />
          ),
        )}
      </div>
      {notice === null ? null : (
        <p role="status" className="m-0 text-meta leading-base text-muted" data-security-notice="">
          {notice}
        </p>
      )}
      {failure === null ? null : (
        <p role="alert" className={cn('m-0 text-meta leading-base', ERROR_TONE)} data-security-failure-settings="">
          {failure}
        </p>
      )}
    </section>
  );
}
