import { implementCli, type TerminalIo, type VerbInvocation } from '@ferretry/kernel/manifest';
import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  CAPABILITY_NAMES,
  type AuditView,
  isSecuritySwitch,
  SECURITY_SETTING_FIELDS,
  type SecuritySettingField,
  type SecuritySettingsPatch,
  type SecuritySettingsView,
} from '../contract/index.ts';
import manifest from '../manifest.ts';
import {
  type GrantHistoryReport,
  type GrantsReport,
  grantDifference,
  renderAudit,
  renderGrantChange,
  renderGrantHistory,
  renderGrants,
  renderSecurity,
  renderSecurityChange,
} from './lib/render.ts';

/** The binary's name, for sentences that name a command. */
const CLIENT_NAME = 'fy';

const SWITCH_WORDS: Readonly<Record<string, boolean>> = { on: true, true: true, off: false, false: false };

const text = (invocation: VerbInvocation, name: string): string | undefined => {
  const value = invocation.options[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[value.length - 1] as string | undefined;
  return undefined;
};
const on = (invocation: VerbInvocation, name: string): boolean => {
  const value = invocation.options[name];
  return value === true || value === 'true';
};

/** Today's `parseLimit`: a limit above what the daemon serves is capped; one that is not a whole number is refused. */
export function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return AUDIT_DEFAULT_LIMIT;
  if (!/^\d+$/u.test(raw.trim())) return undefined;
  const parsed = Number(raw);
  return parsed < 1 ? undefined : Math.min(parsed, AUDIT_MAX_LIMIT);
}

export function parseSkip(raw: string | undefined): number | undefined {
  if (raw === undefined) return 0;
  return /^\d+$/u.test(raw.trim()) ? Number(raw) : undefined;
}

/**
 * The patch for one field, or the sentence saying why the value cannot be one. THE BOUNDS ARE THE DAEMON'S: only the
 * SHAPE is parsed here, so its refusal reaches the person word for word.
 */
export function parseSettingValue(field: SecuritySettingField, value: string): SecuritySettingsPatch | string {
  if (isSecuritySwitch(field)) {
    const word = SWITCH_WORDS[value.trim().toLowerCase()];
    return word === undefined
      ? `${field} takes on, off, true or false, not ${JSON.stringify(value)}`
      : { [field]: word };
  }
  if (!/^[+-]?\d+$/u.test(value.trim())) return `${field} takes a whole number, not ${JSON.stringify(value)}`;
  return { [field]: Number.parseInt(value, 10) };
}

/** An axis switch: `--use` is on, `--no-use` is off, absence says nothing. */
const axisOf = (invocation: VerbInvocation, name: string): boolean | undefined => {
  const value = invocation.options[name];
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
};

function fail(io: TerminalIo, message: string): number {
  io.err(message);
  return 1;
}

/**
 * Gate's `fy` verbs (today's `fy daemon audit` and `fy daemon security …`). Non-interactive: this command line holds
 * the admin token, so it is the one caller allowed to loosen a setting, and it never asks to confirm.
 */
export default implementCli(manifest, {
  build({ client, io }) {
    const show = async (invocation: VerbInvocation): Promise<number> => {
      const view = await client.call<SecuritySettingsView>('GET /v1/security');
      io.out(on(invocation, 'json') ? JSON.stringify(view) : renderSecurity(view, CLIENT_NAME));
      return 0;
    };
    const grants = async (invocation: VerbInvocation): Promise<number> => {
      const view = await client.call<GrantsReport>('GET /v1/grants');
      io.out(on(invocation, 'json') ? JSON.stringify(view) : renderGrants(view, CLIENT_NAME));
      return 0;
    };
    const history = async (invocation: VerbInvocation): Promise<number> => {
      const view = await client.call<GrantHistoryReport>('GET /v1/grants/audit');
      io.out(on(invocation, 'json') ? JSON.stringify(view) : renderGrantHistory(view));
      return 0;
    };
    return {
      verbs: {
        'daemon config': grants,
        'daemon config ls': grants,
        'daemon config history': history,
        'daemon config set <capability>': async invocation => {
          const [capability] = invocation.args;
          const target = CAPABILITY_NAMES.find(candidate => candidate === capability);
          if (target === undefined)
            return fail(
              io,
              `${JSON.stringify(capability ?? '')} is not a capability this daemon has; expected one of ${CAPABILITY_NAMES.join(', ')}`,
            );
          const use = axisOf(invocation, 'use');
          const configure = axisOf(invocation, 'configure');
          if (use === undefined && configure === undefined)
            return fail(
              io,
              'nothing to change: name at least one axis, as `--use`/`--no-use` or `--configure`/`--no-configure`',
            );
          const before = await client.call<GrantsReport>('GET /v1/grants');
          const after = await client.call<GrantsReport>('PATCH /v1/grants', {
            body: {
              [target]: { ...(use === undefined ? {} : { use }), ...(configure === undefined ? {} : { configure }) },
            },
          });
          io.out(renderGrantChange(grantDifference(before, after), CLIENT_NAME));
          return 0;
        },
        'daemon audit': async invocation => {
          const limit = parseLimit(text(invocation, 'limit'));
          if (limit === undefined)
            return fail(
              io,
              `--limit must be a whole number of 1 or more; the most that can be shown is ${String(AUDIT_MAX_LIMIT)}`,
            );
          const keptOffset = parseSkip(text(invocation, 'kept-skip'));
          if (keptOffset === undefined) return fail(io, '--kept-skip must be a whole number of 0 or more');
          const view = await client.call<AuditView>('GET /v1/audit', {
            query: { limit: String(limit), keptOffset: String(keptOffset) },
          });
          io.out(on(invocation, 'json') ? JSON.stringify(view) : renderAudit(view, keptOffset));
          return 0;
        },
        'daemon security': show,
        'daemon security show': show,
        'daemon security set <field> <value>': async invocation => {
          const [field, value] = invocation.args;
          const target = SECURITY_SETTING_FIELDS.find(candidate => candidate === field);
          if (target === undefined)
            return fail(
              io,
              `${JSON.stringify(field ?? '')} is not a security setting; expected one of ${SECURITY_SETTING_FIELDS.join(', ')}`,
            );
          if (value === undefined)
            return fail(io, `say the value: ${CLIENT_NAME} daemon security set ${target} <value>`);
          const patch = parseSettingValue(target, value);
          if (typeof patch === 'string') return fail(io, patch);
          const change = await client.call<{ readonly view: SecuritySettingsView; readonly devicesExpiring: number }>(
            'PATCH /v1/security',
            { body: patch },
          );
          io.out(renderSecurityChange(target, change));
          return 0;
        },
      },
    };
  },
});
