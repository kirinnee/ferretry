import type { LogLevel, RunOverrides } from './arguments.ts';
import type { LogSink } from './log.ts';

const DEFAULT_PORT = 7457;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** Where an effective value came from: the command line, the environment, or the built-in default. */
type Origin = 'flag' | 'environment' | 'default';

interface Setting<T> {
  readonly value: T;
  readonly origin: Origin;
  /** The flag or variable that supplied it, when it was not the default. */
  readonly source?: string;
}

export interface EffectiveSettings {
  readonly home: Setting<string>;
  readonly port: Setting<number>;
  readonly host: Setting<string>;
  readonly logLevel: Setting<LogLevel>;
}

export type SettingsOutcome =
  | { readonly kind: 'settings'; readonly settings: EffectiveSettings }
  | { readonly kind: 'refused'; readonly sentence: string };

/**
 * The values one run uses, each with where it came from (flag over environment over default). Pure: nothing is read
 * but the arguments. A port that is not a port number is refused, never clamped.
 */
export function resolveSettings(
  env: Readonly<Record<string, string | undefined>>,
  overrides: RunOverrides,
  userHome: string,
): SettingsOutcome {
  const pick = <T>(
    flag: [string, T | undefined],
    variable: [string, string | undefined, (text: string) => T],
    fallback: T,
  ): Setting<T> =>
    flag[1] !== undefined
      ? { value: flag[1], origin: 'flag', source: flag[0] }
      : variable[1] !== undefined
        ? { value: variable[2](variable[1]), origin: 'environment', source: variable[0] }
        : { value: fallback, origin: 'default' };
  const port = pick<number>(['--port', overrides.port], ['FY_PORT', env.FY_PORT, Number], DEFAULT_PORT);
  if (!Number.isInteger(port.value) || port.value < 0 || port.value > 65_535)
    return { kind: 'refused', sentence: `${port.source ?? 'the port'} ${String(port.value)} is not a port number.` };
  return {
    kind: 'settings',
    settings: {
      home: pick<string>(
        ['', undefined],
        ['FY_HOME', env.FY_HOME, text => text.replace(/\/+$/, '')],
        `${userHome}/.ferretry`,
      ),
      port,
      host:
        overrides.host === undefined
          ? { value: DEFAULT_HOST, origin: 'default' }
          : { value: overrides.host, origin: 'flag', source: '--host' },
      logLevel:
        overrides.logLevel === undefined
          ? { value: DEFAULT_LOG_LEVEL, origin: 'default' }
          : { value: overrides.logLevel, origin: 'flag', source: '--log-level' },
    },
  };
}

/** `--print-config`: one line per value, then where it came from. Reads nothing and creates nothing. */
export function renderSettings(settings: EffectiveSettings): readonly string[] {
  const row = (name: string, setting: Setting<unknown>): string =>
    `${name.padEnd(10)} ${String(setting.value).padEnd(28)} ${
      setting.origin === 'default' ? 'default' : `${setting.origin} (${setting.source})`
    }`;
  return [
    row('home', settings.home),
    row('port', settings.port),
    row('host', settings.host),
    row('log-level', settings.logLevel),
  ];
}

const RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 0, warn: 1, error: 2 };

/**
 * A sink that drops records below `level`. `debug` is accepted and selects the same records as `info`: this daemon
 * emits nothing of its own below `info` (the usage text says so).
 */
export function filterByLevel(sink: LogSink, level: LogLevel): LogSink {
  return record => {
    if (RANK[record.level] >= RANK[level]) sink(record);
  };
}
