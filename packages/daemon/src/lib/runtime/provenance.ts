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
 * The report as a human reads it: aligned columns, and the one warning worth raising beneath them.
 *
 * The divergence notice is repeated here rather than left to a boot, because this command exists for
 * the person who has not managed to get a boot to work.
 */
export function renderConfiguration(rows: readonly ResolvedValue[], config: DaemonConfig, configFile: string): string {
  const nameWidth = Math.max(...rows.map(row => row.name.length));
  // Capped, because one long state-home path would otherwise push every origin off the right of the
  // terminal — and the origin column is the entire reason this report exists.
  const valueWidth = Math.min(44, Math.max(...rows.map(row => row.value.length)));
  const lines = rows.map(row => {
    const detail = row.note === undefined ? `(${row.origin})` : `(${row.origin} — ${row.note})`;
    return `${row.name.padEnd(nameWidth)}  ${row.value.padEnd(valueWidth)}  ${detail}`;
  });
  if (advertisesForeignAddress(config))
    lines.push('', `! ${foreignAdvertisementNotice(config.bindUrl, config.publicUrl, configFile)}`);
  return lines.join('\n');
}
