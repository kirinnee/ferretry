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
  SECURITY_SETTING_BOUNDS,
  type SecuritySettingField,
  type SecuritySettingsPatch,
  type SecuritySettingsView,
  type SecuritySwitchField,
  widensSecurity,
  widensWithPasskey,
} from '@ferretry/core-gate/contract';
import { SettingGroup, SettingRow, SettingSaveBar, Segmented } from '@ferretry/app';
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
 * Two groups, because they save differently: the two switches take effect NOW; the numbers are one form with ONE Save bar.
 * The numbers follow the order the design lists them in. The change
 * confirmation window is shown only while the machine asks per act, because with it off the number
 * governs nothing a person could see.
 */
const SWITCH_FIELDS = ['unlockOnOpen', 'stepUpOnActions'] as const satisfies readonly SecuritySwitchField[];
const numberFieldsFor = (view: SecuritySettingsView): readonly NumericSecuritySetting[] => [
  'unlockValidityHours',
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
}

/** What one typed number comes to: changed or not, the number it parses to, and the sentence that stops or qualifies it. */
function judgeNumber(field: NumericSecuritySetting, view: SecuritySettingsView, draft: string | undefined) {
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
    (blocked && parsed !== null
      ? widenAtMachineSentence(view.widenCommand, { field, value: parsed })
      : withPasskey
        ? WIDEN_WITH_PASSKEY_SENTENCE
        : null);
  return { current, dirty, parsed, outOfBounds, withPasskey, blocked, note };
}

/** The id the "other value" segment carries when what is typed is not one of the common choices. */
const CUSTOM_CHOICE = 'custom';

/**
 * A number with its common choices: a `Segmented` for the presets, a number box and its unit. It is a FIELD of the Limits form: a
 * preset only fills the box, and the form's one Save bar sends what changed. The saved value, the bounds and any limit sit under the row.
 */
function NumberRow({ field, view, draft, busy, onDraft }: NumberRowProps) {
  const inputId = useId();
  const noteId = useId();
  const copy = SECURITY_SETTING_COPY[field];
  const bounds = SECURITY_SETTING_BOUNDS[field];
  const { current, outOfBounds, blocked, note } = judgeNumber(field, view, draft);
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
            accessibleName={`${copy.label}${dead ? `. ${widenAtMachineSentence(view.widenCommand, { field, value: false })}` : ''}`}
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
            {widenAtMachineSentence(view.widenCommand, { field, value: false })}
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
  const [formFailure, setFormFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let current = true;
    setLoaded({ kind: 'loading' });
    setDrafts({});
    setFormFailure(null);
    setSaved(false);
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

  /** Sends one patch (a switch's one field, or every changed number of the form) and says what the machine now holds. */
  const save = async (
    patch: SecuritySettingsPatch,
    fields: readonly SecuritySettingField[],
    from: 'switch' | 'form',
  ): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setFormFailure(null);
    setNotice(null);
    setSaved(false);
    try {
      const change = await changeSecuritySettings(client, patch);
      setLoaded({ kind: 'ready', client, view: change.view });
      setDrafts(current =>
        Object.fromEntries(Object.entries(current).filter(([key]) => !fields.includes(key as SecuritySettingField))),
      );
      const now = (field: SecuritySettingField): string => {
        const value = change.view.settings[field];
        return typeof value === 'boolean'
          ? value
            ? 'on'
            : 'off'
          : describeSettingValue(field as NumericSecuritySetting, value);
      };
      setNotice(
        [
          ...fields.map(field => `${SECURITY_SETTING_COPY[field].label}: now ${now(field)}.`),
          devicesExpiringSentence(change.devicesExpiring),
        ]
          .filter((sentence): sentence is string => sentence !== null)
          .join(' '),
      );
      if (from === 'form') setSaved(true);
    } catch (reason) {
      const field = fields[0] ?? 'unlockOnOpen';
      const asked = (patch as Readonly<Record<string, string | number | boolean>>)[field];
      const sentence = securityFailureSentence(reason, view.widenCommand, { field, value: asked ?? '' });
      if (from === 'form') setFormFailure(sentence);
      else setFailure(sentence);
    }
    setBusy(false);
  };

  // The Limits form: what is typed, judged field by field; Save sends every changed number as ONE patch and stays off while any is refused.
  const numberFields = numberFieldsFor(view);
  const judged = numberFields.map(field => ({ field, ...judgeNumber(field, view, drafts[field]) }));
  const changed = judged.filter(row => row.dirty);
  const formBlocked = changed.some(row => row.parsed === null || row.blocked || row.outOfBounds !== null);
  const formPatch = Object.fromEntries(
    changed.flatMap(row => (row.parsed === null ? [] : [[row.field, row.parsed]])),
  ) as SecuritySettingsPatch;

  return (
    <AccessTab name="security-settings">
      <div data-security-settings="">
        <SettingGroup label="Prompts" saves="now">
          {view.source === 'damaged' ? (
            <li className="min-w-0">
              <Notice tone="err" role="alert" marks={{ 'data-security-damaged': '' }}>
                {DAMAGED_SETTINGS_SENTENCE}
              </Notice>
            </li>
          ) : null}
          {SWITCH_FIELDS.map(field => (
            <SwitchRow
              key={field}
              field={field}
              view={view}
              busy={busy}
              onSave={value => void save({ [field]: value }, [field], 'switch')}
            />
          ))}
        </SettingGroup>
        <SettingGroup
          label="Limits"
          saves="on-save"
          foot={
            <SettingSaveBar
              dirty={changed.length > 0}
              saving={busy}
              saved={saved}
              error={formFailure}
              blocked={formBlocked}
              saveLabel="Save limits"
              saveMarks={{ 'data-security-save': 'form' }}
              onSave={() =>
                void save(
                  formPatch,
                  changed.map(row => row.field),
                  'form',
                )
              }
              onDiscard={() => {
                setDrafts({});
                setFormFailure(null);
                setSaved(false);
              }}
            />
          }
        >
          {numberFields.map(field => (
            <NumberRow
              key={field}
              field={field}
              view={view}
              draft={drafts[field]}
              busy={busy}
              onDraft={draft => {
                setSaved(false);
                setDrafts(current => ({ ...current, [field]: draft }));
              }}
            />
          ))}
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
