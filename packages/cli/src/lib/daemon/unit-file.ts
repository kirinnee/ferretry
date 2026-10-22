import { parsePlist, plistString } from './plist.ts';

/**
 * The exit code the daemon uses to say "another one of me already owns this address". It is a
 * published part of the daemon's boot contract; the CLI mirrors the constant rather than importing
 * the daemon package, because the CLI depends on the protocol and nothing else in this workspace.
 */
export const EXIT_ALREADY_RUNNING = 78;

/**
 * The exit code for an address held by a responder that is NOT one of these daemons, mirrored from
 * the same boot contract for the same reason.
 *
 * It is a SEPARATE code because the remedy is a separate one — a human must free the address or
 * choose another — and it prevents restarts for the same reason 78 does: no amount of respawning
 * clears a port somebody else's program is holding.
 *
 * Module-private: only the rendered unit needs it, and the rendered unit is what a test should be
 * asserting on anyway — a constant a test reads back from its own source proves nothing about the
 * file systemd will load.
 */
const EXIT_ADDRESS_CONFLICT = 69;

export class InvalidUnitValueError extends Error {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`cannot write the service definition: ${field} ${reason}`);
    this.name = 'InvalidUnitValueError';
  }
}

/**
 * `StandardOutput=` / `StandardError=` take a FILE SPECIFIER, not a quotable argument. systemd
 * parses `append:/path` structurally, so wrapping it in quotes makes the line unparseable: the unit
 * still loads, journald logs "Failed to parse output specifier, ignoring", and the setting is
 * silently dropped.
 *
 * The consequence is worse than a lost setting. Output falls back to the journal, the log file stops
 * being written, and it freezes at whatever it last held — so anyone debugging by reading that file
 * is reading a fossil and cannot tell.
 *
 * So: no quoting. `%` is doubled because systemd expands specifiers like `%h` in this value, and a
 * newline is refused outright rather than written out to fail confusingly at unit load.
 */
export function systemdFileSpecifier(value: string, field: string): string {
  if (/[\n\r]/u.test(value)) throw new InvalidUnitValueError(field, 'may not contain a newline');
  return value.replaceAll('%', '%%');
}

/** A double-quoted systemd value: backslash-escaped, with `%` doubled so no specifier expands. */
export function systemdQuote(value: string): string {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
    .replaceAll('%', '%%')}"`;
}

/**
 * A command-line argument for `ExecStart=`: quoted, with `$` doubled as well.
 *
 * `ExecStart=` is the one directive here that substitutes `$NAME` and `${NAME}` from the unit's
 * environment, quoted or not, and `$$` is its only escape. An executable path holding a `$` would
 * otherwise launch a different path from the one recorded. `Environment=` and `Description=` do not
 * substitute, so doubling there would write a second `$` into the value itself.
 */
function systemdArgument(value: string): string {
  return systemdQuote(value).replaceAll('$', () => '$$');
}

/** Undo {@link systemdQuote}: `undefined` for anything it could not have written. */
function systemdUnquote(quoted: string): string | undefined {
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) return undefined;
  const escapes: Readonly<Record<string, string>> = { '\\': '\\', '"': '"', n: '\n', r: '\r', t: '\t' };
  const body = quoted.slice(1, -1);
  let value = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] ?? '';
    const next = body[index + 1] ?? '';
    if (character === '\\' || (character === '%' && next === '%')) {
      const decoded = character === '%' ? '%' : escapes[next];
      if (decoded === undefined) return undefined;
      value += decoded;
      index += 1;
    } else if (character === '"' || character === '%') {
      return undefined;
    } else {
      value += character;
    }
  }
  return value;
}

/** The variable prefix both readers below look for. */
const STATE_HOME_ASSIGNMENT = 'FY_HOME=';

/**
 * The state home a systemd unit this CLI rendered hands its daemon, or `undefined` when it names none.
 *
 * There is ONE unit name per host, whatever `FY_HOME` says, so the unit is the only record of which
 * state home it supervises. A lifecycle verb run under a different `FY_HOME` reads it here before it
 * stops, restarts, resets or rewrites the daemon somebody else's state home depends on.
 */
export function systemdUnitStateHome(unit: string): string | undefined {
  for (const line of unit.split('\n')) {
    if (!line.startsWith('Environment=')) continue;
    const assignment = systemdUnquote(line.slice('Environment='.length).trimEnd());
    if (assignment?.startsWith(STATE_HOME_ASSIGNMENT) === true) return assignment.slice(STATE_HOME_ASSIGNMENT.length);
  }
  return undefined;
}

/** The state home a launchd plist this CLI rendered hands its daemon, for the same reason. */
export function launchAgentStateHome(plist: string): string | undefined {
  return plistString(parsePlist(plist), 'EnvironmentVariables', 'FY_HOME');
}

/**
 * The launchd `ProcessType` the daemon's job declares.
 *
 * launchd.plist(5): a job that names NONE gets "light resource limits … throttling its CPU usage and
 * I/O bandwidth", and every child inherits them — the multiplexer, the agents and every `ps` or
 * `security` the daemon runs. An owner's Mac showed what that costs an interactive daemon: 5.6% of a
 * core used, 63,566 involuntary context switches against 132 voluntary ones, a 1 KB key file taking
 * 650 ms to read and the event loop blocked 23 s of every 60. `Interactive` is "the same resource
 * limitations as apps, that is to say, none", which is what a daemon a person is waiting on needs.
 *
 * It is also what keeps the job out of App Nap's reach: App Nap is an AppKit policy applied to apps
 * through `NSProcessInfo`, and a launchd agent's scheduling class comes from this key, so there is
 * nothing for the daemon itself to opt out of at runtime.
 */
export const LAUNCHD_PROCESS_TYPE = 'Interactive';

/**
 * The `ProcessType` a launchd plist declares, or `undefined` when it declares none — which is the
 * throttled default, and what every plist rendered before {@link LAUNCHD_PROCESS_TYPE} existed says.
 */
export function launchAgentProcessType(plist: string): string | undefined {
  return plistString(parsePlist(plist), 'ProcessType');
}

/** Tab, newline and carriage return are the only C0 characters XML 1.0 can represent at all. */
function hasForbiddenControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

/**
 * XML text for a plist value.
 *
 * Escaping the five predefined entities is not sufficient: XML 1.0 forbids most C0 control
 * characters outright, and there is no escape that makes them legal. kteam escaped only the entities,
 * so a control byte anywhere in `PATH` or the state home produced a plist that `launchctl` rejected
 * with a parse error naming a byte offset, not a cause. Refuse it here instead, where we can say why.
 */
export function xmlText(value: string, field: string): string {
  if (hasForbiddenControlCharacter(value)) {
    throw new InvalidUnitValueError(field, 'may not contain a control character');
  }
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** What both service definitions need to say about the daemon they supervise. */
export interface ServiceDefinitionSpec {
  /** Absolute path to the daemon executable. */
  readonly daemonBinary: string;
  /** The state home to hand it as `FY_HOME`. */
  readonly stateHome: string;
  /**
   * The user home to hand it as `HOME` — the one the installing CLI resolved. Both service managers
   * would supply the user database's home themselves, which is a different directory whenever `fy`
   * ran under another `HOME`, and the daemon looks for harness logins under whichever it is given.
   */
  readonly userHome: string;
  /** Where its stdout and stderr are appended. */
  readonly logFile: string;
  /** The `PATH` it inherits; a service manager provides almost none. */
  readonly searchPath: string;
  /**
   * The UTF-8 locale it runs under. A service manager provides none, and without one the terminal
   * multiplexer every session runs in rewrites tabs and unicode as `_`.
   */
  readonly locale: Readonly<Record<string, string>>;
  /** Engine options read once at VM start; see `DAEMON_RUNTIME_TUNING`. */
  readonly runtime: Readonly<Record<string, string>>;
  /** Human description for the unit header. */
  readonly description: string;
}

/** The variables sorted by name, so one input renders one file. */
function sortedEntries(variables: Readonly<Record<string, string>>): readonly (readonly [string, string])[] {
  return Object.entries(variables).sort(([left], [right]) => (left < right ? -1 : 1));
}

function systemdEnvironment(variables: Readonly<Record<string, string>>): string {
  return sortedEntries(variables)
    .map(([name, value]) => `Environment=${systemdQuote(`${name}=${value}`)}\n`)
    .join('');
}

function plistEnvironment(variables: Readonly<Record<string, string>>): string {
  return sortedEntries(variables)
    .map(([name, value]) => `<key>${xmlText(name, 'a variable name')}</key><string>${xmlText(value, name)}</string>`)
    .join('');
}

/** Renders the systemd user unit. */
export function renderSystemdUnit(spec: ServiceDefinitionSpec): string {
  const logSpecifier = systemdFileSpecifier(spec.logFile, 'the log path');
  return `[Unit]
Description=${systemdQuote(spec.description)}
After=network.target

[Service]
Type=simple
ExecStart=${systemdArgument(spec.daemonBinary)}
Restart=always
RestartSec=2
# The daemon exits with the first code when another one of it already owns the address, and with the
# second when something else does. Re-spawning against a working daemon every RestartSec accomplishes
# nothing but noise, and no restart can take an address a different program is holding.
RestartPreventExitStatus=${String(EXIT_ALREADY_RUNNING)} ${String(EXIT_ADDRESS_CONFLICT)}
# The terminal multiplexer server hosting every session pane is spawned from this unit and therefore
# lives in its control group. The default control-group kill erased the whole fleet on every daemon
# restart. Signal only the daemon; panes survive and boot recovery re-adopts them.
KillMode=process
Environment=${systemdQuote(`FY_HOME=${spec.stateHome}`)}
Environment=${systemdQuote(`HOME=${spec.userHome}`)}
Environment=${systemdQuote(`PATH=${spec.searchPath}`)}
${systemdEnvironment(spec.locale)}${systemdEnvironment(spec.runtime)}StandardOutput=append:${logSpecifier}
StandardError=append:${logSpecifier}

[Install]
WantedBy=default.target
`;
}

/** What a launchd job needs beyond the shared definition. */
export interface LaunchAgentSpec extends ServiceDefinitionSpec {
  /** The job label; also the plist's base name. */
  readonly label: string;
}

/**
 * Renders the launchd user agent.
 *
 * `AbandonProcessGroup` is what lets the multiplexer server outlive a daemon restart, mirroring
 * systemd's `KillMode=process`. launchd has no equivalent of `RestartPreventExitStatus`, so a
 * daemon that keeps finding an incumbent is re-spawned; `ThrottleInterval` bounds how fast, which is
 * the most launchd can express and more than kteam's plist said at all. `ProcessType` is
 * {@link LAUNCHD_PROCESS_TYPE}, because leaving it out has macOS throttle the whole fleet.
 */
export function renderLaunchAgentPlist(spec: LaunchAgentSpec): string {
  const log = xmlText(spec.logFile, 'the log path');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xmlText(spec.label, 'the label')}</string>
<key>ProgramArguments</key><array><string>${xmlText(spec.daemonBinary, 'the daemon path')}</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>AbandonProcessGroup</key><true/>
<key>ProcessType</key><string>${LAUNCHD_PROCESS_TYPE}</string>
<key>StandardOutPath</key><string>${log}</string>
<key>StandardErrorPath</key><string>${log}</string>
<key>EnvironmentVariables</key><dict><key>FY_HOME</key><string>${xmlText(spec.stateHome, 'the state home')}</string><key>HOME</key><string>${xmlText(spec.userHome, 'the user home')}</string><key>PATH</key><string>${xmlText(spec.searchPath, 'PATH')}</string>${plistEnvironment(spec.locale)}${plistEnvironment(spec.runtime)}</dict>
</dict></plist>
`;
}
