/**
 * The exit code the daemon uses to say "a healthy responder already owns this address". It is a
 * published part of the daemon's boot contract; the CLI mirrors the constant rather than importing
 * the daemon package, because the CLI depends on the protocol and nothing else in this workspace.
 */
export const EXIT_ALREADY_RUNNING = 78;

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
  /** Where its stdout and stderr are appended. */
  readonly logFile: string;
  /** The `PATH` it inherits; a service manager provides almost none. */
  readonly searchPath: string;
  /** Human description for the unit header. */
  readonly description: string;
}

/** Renders the systemd user unit. */
export function renderSystemdUnit(spec: ServiceDefinitionSpec): string {
  const logSpecifier = systemdFileSpecifier(spec.logFile, 'the log path');
  return `[Unit]
Description=${systemdQuote(spec.description)}
After=network.target

[Service]
Type=simple
ExecStart=${systemdQuote(spec.daemonBinary)}
Restart=always
RestartSec=2
# The daemon exits with this code when a healthy responder already owns its address. Re-spawning
# against a working daemon every RestartSec accomplishes nothing but noise.
RestartPreventExitStatus=${String(EXIT_ALREADY_RUNNING)}
# The terminal multiplexer server hosting every session pane is spawned from this unit and therefore
# lives in its control group. The default control-group kill erased the whole fleet on every daemon
# restart. Signal only the daemon; panes survive and boot recovery re-adopts them.
KillMode=process
Environment=${systemdQuote(`FY_HOME=${spec.stateHome}`)}
Environment=${systemdQuote(`PATH=${spec.searchPath}`)}
StandardOutput=append:${logSpecifier}
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
 * the most launchd can express and more than kteam's plist said at all.
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
<key>StandardOutPath</key><string>${log}</string>
<key>StandardErrorPath</key><string>${log}</string>
<key>EnvironmentVariables</key><dict><key>FY_HOME</key><string>${xmlText(spec.stateHome, 'the state home')}</string><key>PATH</key><string>${xmlText(spec.searchPath, 'PATH')}</string></dict>
</dict></plist>
`;
}
