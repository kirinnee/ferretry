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
 * there. Nothing is drawn that would only fail on press. The one exception is how long an unlock lasts
 * (`widensWithPasskey`): a device may raise it with a passkey proved for that change, so its Save stays
 * on and one sentence says the passkey will be asked for.
 *
 * ## EVERY FAILURE IS ONE SENTENCE
 *
 * No status, code or error name reaches the screen; see `securityFailureSentence`.
 */

import { Loading } from '@ferretry/app/ui';
import {
  isSecuritySwitch,
  SECURITY_SETTING_BOUNDS,
  type SecuritySettingField,
  type SecuritySettingsPatch,
  type SecuritySettingsView,
  type SecuritySwitchField,
  widensSecurity,
  widensWithPasskey,
} from '@ferretry/core-gate/contract';
import { SettingGroup, SettingRow, Segmented } from '@ferretry/app';
import { useEffect, useId, useState } from 'react';
import type { DaemonConnection } from '../../shell-grants.ts';
import { AccessTab, LabelledSwitch, Notice, StateBlock } from './access-kit.tsx';
import {
  boundsLabel,
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
  SECURITY_SETTING_PRESETS,
  type SecuritySettingsClient,
  securityFailureSentence,
  WIDEN_WITH_PASSKEY_SENTENCE,
  widenAtMachineSentence,
} from '../../lib/security-settings-client.ts';

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

interface NumberRowProps {
  readonly field: NumericSecuritySetting;
  readonly view: SecuritySettingsView;
  /** What is typed but not saved; `undefined` while the input shows the saved value. */
  readonly draft: string | undefined;
  readonly busy: boolean;
  readonly onDraft: (draft: string) => void;
  readonly onSave: (value: number) => void;
}

/** The id the "other value" segment carries when what is typed is not one of the common choices. */
const CUSTOM_CHOICE = 'custom';

/**
 * A number with its common choices: a `Segmented` for the presets, a number box, its unit, and Save once it differs from the
 * saved value. A preset only fills the box; Save sends it. The saved value, the bounds and any limit sit under the row.
 */
function NumberRow({ field, view, draft, busy, onDraft, onSave }: NumberRowProps) {
  const inputId = useId();
  const noteId = useId();
  const copy = SECURITY_SETTING_COPY[field];
  const bounds = SECURITY_SETTING_BOUNDS[field];
  const current = view.settings[field];
  const dirty = draft !== undefined && draft !== String(current);
  const parsed = draft === undefined ? null : parseSettingDraft(field, draft);
  const outOfBounds = dirty && draft !== undefined ? boundsSentence(field, draft) : null;
  // A change that widens (loosens) security is held at the machine unless it can ride a passkey.
  const widens = parsed !== null && widensSecurity(field, current, parsed) && !view.mayWiden;
  const withPasskey = widens && widensWithPasskey(field);
  const blocked = widens && !withPasskey;
  const note =
    outOfBounds ??
    (blocked ? widenAtMachineSentence(view.widenCommand) : withPasskey ? WIDEN_WITH_PASSKEY_SENTENCE : null);
  const shown = draft ?? String(current);
  const presets = SECURITY_SETTING_PRESETS[field] ?? [];
  const onPreset = presets.some(value => String(value) === shown);
  return (
    <SettingRow
      name={copy.label}
      hint={copy.explanation}
      wide
      dataAttributes={{ 'data-security-setting': field }}
      control={() => (
        <div className="fy-acc-number">
          {presets.length === 0 ? null : (
            <Segmented
              label={`${copy.label}: common choices`}
              value={onPreset ? shown : CUSTOM_CHOICE}
              disabled={busy}
              options={[
                ...presets.map(value => ({ id: String(value), label: describeSettingValue(field, value) })),
                ...(onPreset ? [] : [{ id: CUSTOM_CHOICE, label: 'Other' }]),
              ]}
              onChange={next => {
                if (next !== CUSTOM_CHOICE) onDraft(next);
              }}
            />
          )}
          <input
            id={inputId}
            type="number"
            inputMode="numeric"
            min={bounds.min}
            max={bounds.max}
            step={1}
            value={shown}
            disabled={busy}
            aria-label={copy.label}
            aria-describedby={note === null ? undefined : noteId}
            aria-invalid={outOfBounds === null ? undefined : true}
            data-security-input={field}
            onChange={event => onDraft(event.currentTarget.value)}
            className="kt-input !min-h-[44px] !w-24 min-w-0"
          />
          <span className="text-meta text-muted" aria-hidden="true">
            {copy.unit?.many}
          </span>
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
      )}
    >
      <div className="fy-acc-body">
        <p className="fy-acc-fine">
          Now{' '}
          <span className="font-semibold text-fg" data-security-value={field}>
            {describeSettingValue(field, current)}
          </span>
          {' · '}
          <span data-security-bounds={field}>{boundsLabel(field)}</span>
        </p>
        {note === null ? null : (
          <Notice
            tone={outOfBounds === null ? 'info' : 'err'}
            id={noteId}
            marks={{
              'data-security-note-kind': outOfBounds === null ? (blocked ? 'at-machine' : 'passkey') : 'bounds',
              'data-security-note': field,
            }}
          >
            {note}
          </Notice>
        )}
      </div>
    </SettingRow>
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
  const copy = SECURITY_SETTING_COPY[field];
  const on = view.settings[field];
  const dead = on && !view.mayWiden;
  return (
    <SettingRow
      name={copy.label}
      hint={copy.explanation}
      dataAttributes={{ 'data-security-setting': field }}
      control={() => (
        <>
          <span className="text-ui text-fg" data-security-value={field}>
            {on ? 'On' : 'Off'}
          </span>
          <LabelledSwitch
            label={on ? 'On' : 'Off'}
            showLabel={false}
            accessibleName={`${copy.label}${dead ? `. ${widenAtMachineSentence(view.widenCommand)}` : ''}`}
            checked={on}
            disabled={busy || dead}
            onChange={next => onSave(next)}
            marks={{ 'data-security-switch': field }}
          />
        </>
      )}
    >
      {dead ? (
        <div className="fy-acc-body">
          <Notice tone="info" marks={{ 'data-security-note': field }}>
            {widenAtMachineSentence(view.widenCommand)}
          </Notice>
        </div>
      ) : null}
    </SettingRow>
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

  if (loaded.kind === 'loading')
    return (
      <Loading
        kind="page"
        label="Reading this machine’s security settings…"
        marks={{ 'data-security-settings-state': 'loading' }}
      />
    );
  if (loaded.kind !== 'ready')
    return (
      <StateBlock
        title="Security settings"
        label="Security settings"
        marks={{ 'data-security-settings-state': loaded.kind }}
      >
        <p className="fy-acc-fine">{SECURITY_LOAD_FAILURE}</p>
      </StateBlock>
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
    <AccessTab name="security-settings">
      <div data-security-settings="">
        <SettingGroup label="Security settings">
          {view.source === 'damaged' ? (
            <li className="min-w-0">
              <Notice tone="err" role="alert" marks={{ 'data-security-damaged': '' }}>
                {DAMAGED_SETTINGS_SENTENCE}
              </Notice>
            </li>
          ) : null}
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
        </SettingGroup>
        {notice === null ? null : (
          <Notice tone="info" role="status" marks={{ 'data-security-notice': '' }}>
            {notice}
          </Notice>
        )}
        {failure === null ? null : (
          <Notice tone="err" role="alert" marks={{ 'data-security-failure-settings': '' }}>
            {failure}
          </Notice>
        )}
      </div>
    </AccessTab>
  );
}
