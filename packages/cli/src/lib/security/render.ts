import {
  isSecuritySwitch,
  SECURITY_SETTING_BOUNDS,
  SECURITY_SETTING_FIELDS,
  type SecuritySettingField,
  type SecuritySettings,
  type SecuritySettingsChange,
  type SecuritySettingsView,
} from '@ferretry/protocol';

/** One setting's value as a person types it back: `on`/`off` for the switch, the number otherwise. */
export function formatSettingValue(field: SecuritySettingField, settings: SecuritySettings): string {
  if (isSecuritySwitch(field)) return settings[field] ? 'on' : 'off';
  return String(settings[field]);
}

function boundsOf(field: SecuritySettingField): string {
  if (isSecuritySwitch(field)) return 'on | off';
  const { min, max } = SECURITY_SETTING_BOUNDS[field];
  return `${String(min)}-${String(max)}`;
}

/**
 * The settings report: each value, its bounds, and where the document came from.
 *
 * A DAMAGED DOCUMENT IS SAID OUT LOUD, because the values shown are then the fail-closed reading and
 * not anything somebody chose; a table that hid that would read as a deliberate configuration.
 */
export function renderSecurity(view: SecuritySettingsView, clientName: string): string {
  const nameWidth = Math.max(...SECURITY_SETTING_FIELDS.map(field => field.length));
  const valueWidth = Math.max(...SECURITY_SETTING_FIELDS.map(field => formatSettingValue(field, view.settings).length));
  const lines = SECURITY_SETTING_FIELDS.map(
    field =>
      `${field.padEnd(nameWidth)}  ${formatSettingValue(field, view.settings).padEnd(valueWidth)}  (${boundsOf(field)})`,
  );
  const origin: Record<SecuritySettingsView['source'], string> = {
    document: 'source: the settings document',
    defaults: 'source: defaults (nothing has been changed on this machine)',
    damaged:
      'source: DAMAGED — the settings document could not be read, so the narrowest reading is in force; fix or remove it',
  };
  return [
    ...lines,
    '',
    origin[view.source],
    ...(view.updatedAt === undefined ? [] : [`updated: ${view.updatedAt}`]),
    '',
    `change one with \`${clientName} daemon security set <field> <value>\``,
  ].join('\n');
}

/** What a change reports: the new value, and the devices a shortened idle period will unpair. */
export function renderSecurityChange(field: SecuritySettingField, change: SecuritySettingsChange): string {
  const lines = [`${field} = ${formatSettingValue(field, change.view.settings)}`];
  if (change.devicesExpiring > 0)
    lines.push(`${String(change.devicesExpiring)} paired device(s) will be unpaired at the next check`);
  return lines.join('\n');
}
