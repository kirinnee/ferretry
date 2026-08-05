import { CAPABILITY_AXES, DAEMON_CAPABILITIES } from '@ferretry/protocol';
import { NO_PASSWORD_DISCLOSURE } from '../grants/policy.ts';
import type { RunOverrides } from './arguments.ts';
import { foreignAdvertisementNotice } from './boot.ts';
import { advertisesForeignAddress, type DaemonConfig } from './config.ts';

/**
 * Where one effective value came from.
 *
 * THIS IS THE HEADLINE OF THE WHOLE SURFACE, not a nice-to-have. A person lost an evening to `port`
 * and `publicUrl` silently disagreeing — the daemon knew both values and every reason for them, and
 * had no way to say so, so the entire evening went on guessing at state the binary already held.
 * Printing a value without its origin would have shown the two numbers and left the same question:
 * which of these did I choose, and which did something choose for me? The ORIGIN is the answer.
 */
export type ValueOrigin = 'default' | 'config file' | 'flag' | 'derived' | 'environment';

export interface ResolvedValue {
  readonly name: string;
  readonly value: string;
  readonly origin: ValueOrigin;
  /** Why this origin, when the origin alone would still leave a question. */
  readonly note?: string;
}

/** Everything the report is assembled from, so none of it is read from a global. */
export interface ConfigurationReport {
  /** The document as it was found on disk, or `undefined` when there is none yet. */
  readonly document: Record<string, unknown> | undefined;
  /** The configuration that would actually be in effect. */
  readonly config: DaemonConfig;
  readonly overrides: RunOverrides;
  readonly configFile: string;
  readonly stateHome: string;
  /** Whether `FY_HOME` chose the state home, rather than the default under the user's home. */
  readonly stateHomeFromEnvironment: boolean;
}

/** The document keys reported in the order an operator reads them: address first, then the rest. */
const REPORTED_KEYS = [
  'host',
  'port',
  'publicUrl',
  'corsOrigins',
  'secretsFile',
  'healthIntervalSeconds',
  'transcriptReconcileSeconds',
  'usage',
  'analyticsPricing',
  'projectRoots',
] as const;

/** Which override, if any, replaced a document key for this run. */
const OVERRIDDEN_BY: Partial<Record<(typeof REPORTED_KEYS)[number], keyof RunOverrides>> = {
  host: 'host',
  port: 'port',
};

function render(value: unknown): string {
  if (value === undefined) return '(none)';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length === 0 ? '(empty)' : JSON.stringify(value);
  return JSON.stringify(value);
}

/**
 * Every effective value with the reason it holds that value.
 *
 * THE UNSET FIELDS ARE REPORTED TOO, as `(none)` from `default`. An operator asking what is in effect
 * is often asking why something they expected is not happening, and a report that only listed what
 * had been set could not answer that.
 */
export function describeConfiguration(report: ConfigurationReport): readonly ResolvedValue[] {
  const document = report.document ?? {};
  const effective = report.config as unknown as Record<string, unknown>;
  const rows: ResolvedValue[] = [
    {
      name: 'state home',
      value: report.stateHome,
      origin: report.stateHomeFromEnvironment ? 'environment' : 'default',
      ...(report.stateHomeFromEnvironment ? { note: 'FY_HOME' } : {}),
    },
    {
      name: 'config file',
      value: report.configFile,
      origin: report.overrides.configFile === undefined ? 'default' : 'flag',
      ...(report.document === undefined ? { note: 'not written yet' } : {}),
    },
  ];
  for (const key of REPORTED_KEYS) {
    const override = OVERRIDDEN_BY[key];
    const overridden = override !== undefined && report.overrides[override] !== undefined;
    // An unrecorded port is the one value whose effective number is not the document's and not a
    // flag's, and saying "default" alone would hide that this boot is free to move off it.
    const unrecordedPort = key === 'port' && !overridden && document[key] === undefined;
    rows.push({
      name: key,
      value: render(effective[key]),
      origin: overridden ? 'flag' : document[key] === undefined ? 'default' : 'config file',
      ...(unrecordedPort ? { note: 'preferred, not claimed — this boot may take the next free address' } : {}),
      ...(key === 'publicUrl' && document[key] === undefined ? { note: 'follows host and port' } : {}),
    });
  }
  for (const row of describeGrants(report)) rows.push(row);
  rows.push({
    name: 'bind url',
    value: report.config.bindUrl,
    origin: 'derived',
    note: 'from host and port; this is the address that is probed and bound',
  });
  rows.push({
    name: 'log level',
    value: report.overrides.logLevel ?? 'info',
    origin: report.overrides.logLevel === undefined ? 'default' : 'flag',
  });
  return rows;
}

/**
 * What a NON-LOOPBACK caller may do, one row per capability.
 *
 * PER CAPABILITY RATHER THAN ONE `grants` ROW, because the whole value of this report is the origin
 * column, and a single row rendering ten booleans as JSON would answer "what" while destroying "which
 * of these did I choose". An operator who wrote down `warden` and left the other four alone can read
 * that here in one glance; a single row would have shown all five as `config file`.
 *
 * THE ROW SAYS WHO IT APPLIES TO. `--print-config` is read by somebody trying to work out why
 * something is refused, and the commonest wrong answer would be to see `configure off` and conclude
 * their own command line is blocked. Loopback is ungoverned, so the heading says so once.
 */
function describeGrants(report: ConfigurationReport): readonly ResolvedValue[] {
  const document = (report.document ?? {}) as { readonly grants?: Record<string, Record<string, unknown>> };
  return DAEMON_CAPABILITIES.map(capability => {
    const grant = report.config.grants[capability] ?? { use: false, configure: false };
    const written = document.grants?.[capability];
    // Per AXIS, not per capability: an operator who wrote `{"use": false}` and left `configure` alone
    // chose one of the two, and a row claiming both came from the file would be false.
    const chosen = CAPABILITY_AXES.filter(axis => written?.[axis] !== undefined);
    return {
      name: `grants.${capability}`,
      value: CAPABILITY_AXES.map(axis => `${axis}=${grant[axis] ? 'on' : 'off'}`).join(' '),
      origin: chosen.length === 0 ? ('default' as const) : ('config file' as const),
      ...(chosen.length === 1 && chosen[0] !== undefined
        ? { note: `${chosen[0]} was written down; the other is the default` }
        : {}),
    };
  });
}

/**
 * Whether anything OFF this host can reach this daemon at all.
 *
 * IT DECIDES WHETHER THE GRANTS MATTER, which is why `--check` asks it before printing them. A daemon
 * bound to loopback with no relay is reachable only by callers the grant layer does not govern, so
 * reciting five capabilities at that operator would be noise dressed as security — and worse, it
 * would imply a boundary that is not doing anything.
 *
 * TWO WAYS IN, and the second is the one people forget. The bind address is the obvious one. The
 * relay is the other: the daemon DIALS OUT to a rendezvous, so a loopback bind is still reachable
 * from anywhere the moment a relay is configured and enabled. A posture that looked only at `host`
 * would tell somebody running the hosted relay that nothing could reach them.
 */
export function reachableOffHost(config: DaemonConfig): { readonly reachable: boolean; readonly how: string } {
  const relay = config.relay;
  if (relay !== undefined && relay.enabled) return { reachable: true, how: `the relay at ${relay.url}` };
  // Exactly the spellings that name this machine to itself. Anything else — a LAN address, a public
  // one, or the `0.0.0.0` wildcard — accepts connections from off the host.
  const loopback = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
  if (loopback.has(config.host)) return { reachable: false, how: `host ${config.host}, no relay` };
  return { reachable: true, how: `host ${config.host}` };
}

/**
 * The grant posture in the shape `--check` speaks: a label, a value, and a reason.
 *
 * ONE LINE WHEN THERE IS ONE THING TO SAY. The owner's standing complaint is that this product knows
 * something and does not say it, so a person asking "would this daemon start" should also be told, in
 * passing, what it will let a phone do once it has — without having to know the grant surface exists.
 *
 * IT READS THE DOCUMENT, NOT A SECOND COPY. `grants` comes from the same parsed configuration
 * `--print-config` reports and the daemon enforces; `passwordSet` comes from the same verifier port
 * the grant service asks. There is no third answer to drift.
 */
export function describeGrantPosture(input: {
  readonly config: DaemonConfig;
  readonly passwordSet: boolean;
  readonly clientName: string;
}): readonly string[] {
  const reach = reachableOffHost(input.config);
  if (!reach.reachable)
    return [`grants       nothing off this host can reach this daemon (${reach.how}), so no grant applies today`];
  const used = DAEMON_CAPABILITIES.filter(capability => input.config.grants[capability]?.use === true);
  const configurable = DAEMON_CAPABILITIES.filter(capability => input.config.grants[capability]?.configure === true);
  const lines = [
    `grants       reachable off this host (${reach.how}) — a remote caller may use ${listed(used)}, and change settings for ${listed(configurable)}`,
  ];
  // The disclosure, ONCE, and only where it is both true and load-bearing: a machine nothing can
  // reach off-loopback has nothing to disclose, and a machine with a password has a gate to name.
  lines.push(
    input.passwordSet
      ? `             an operator password gates every one of those changes`
      : `             ! ${NO_PASSWORD_DISCLOSURE}; set one with \`${input.clientName} daemon password set\``,
  );
  return lines;
}

/** A capability list as a sentence, with the two ends of the range spelled rather than implied. */
function listed(capabilities: readonly string[]): string {
  if (capabilities.length === 0) return 'nothing';
  if (capabilities.length === DAEMON_CAPABILITIES.length) return 'everything';
  return capabilities.join(', ');
}

/**
 * The report as a human reads it: aligned columns, and the one warning worth raising beneath them.
 *
 * The divergence notice is repeated here rather than left to a boot, because this command exists for
 * the person who has not managed to get a boot to work.
 */
export function renderConfiguration(rows: readonly ResolvedValue[], config: DaemonConfig, configFile: string): string {
  const nameWidth = Math.max(...rows.map(row => row.name.length));
  // Capped, because one long state-home path would otherwise push every origin off the right of the
  // terminal — and the origin column is the entire reason this report exists.
  const valueWidth = Math.min(40, Math.max(...rows.map(row => row.value.length)));
  const lines = rows.map(row => {
    const detail = row.note === undefined ? `(${row.origin})` : `(${row.origin} — ${row.note})`;
    return `${row.name.padEnd(nameWidth)}  ${row.value.padEnd(valueWidth)}  ${detail}`;
  });
  // Stated ONCE, beneath the rows rather than repeated on each of them: the grant rows are meaningless
  // without it, and a person reading five identical parentheticals stops reading them.
  if (rows.some(row => row.name.startsWith('grants.')))
    lines.push('', 'grants apply to callers that are NOT on this host; a loopback caller is ungoverned.');
  if (advertisesForeignAddress(config))
    lines.push('', `! ${foreignAdvertisementNotice(config.bindUrl, config.publicUrl, configFile)}`);
  return lines.join('\n');
}
