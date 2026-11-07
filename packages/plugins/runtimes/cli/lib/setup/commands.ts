import type { VerbInvocation } from '@ferretry/kernel/manifest';
import type { AccountChange, HarnessScan, SetupScan } from '../../../contract/index.ts';
import { runChange } from '../fleet/account-change.ts';
import { requireMayApply } from '../fleet/account-authority.ts';
import { flagOn, flagText, parseHarness, positional, writeFlags } from '../fleet/account-commands.ts';
import { type AccountCommandDeps, AccountCommandError, type AccountWriteOptions } from '../fleet/account-ports.ts';
import { HARNESS_LABEL, indent, listOrNone, unavailable } from '../fleet/account-render.ts';

/** What the first run found for one tool, before anybody chooses. Names only, never a value. */
export function renderHarnessScan(scan: HarnessScan): string {
  const account = scan.account;
  const login =
    account.state === 'signed-in' || account.state === 'refresh-due'
      ? `signed in${account.email ? ` as ${account.email}` : ''}`
      : account.state.replace(/-/gu, ' ');
  return [
    HARNESS_LABEL[scan.harness],
    ...indent([
      `Your login: ${login}${account.reason ? ` (${account.reason})` : ''}`,
      ...(scan.instructions === undefined ? [] : [`Instructions: ${scan.instructions.source}`]),
      ...(scan.settings === undefined
        ? []
        : [`Settings: ${scan.settings.source} (${scan.settings.count} setting(s), ${scan.settings.hooks} hook(s))`]),
      `MCP servers: ${listOrNone(scan.mcpServers)}`,
      `Skills: ${listOrNone(scan.skills)}`,
      ...(scan.secretKeys.length === 0
        ? []
        : [`Moved to the secret store, never copied as text: ${scan.secretKeys.join(', ')}`]),
      ...scan.missingCommands.map(command => `Command not found on this machine: ${command}`),
      ...scan.problems.map(problem => `Problem: ${problem}`),
    ]),
  ].join('\n');
}

/** Whether a harness's own login is one a runtime could launch with now. */
const signedIn = (scan: HarnessScan): boolean =>
  scan.account.state === 'signed-in' || scan.account.state === 'refresh-due';

/** A tool that is not installed, with the command that would install it. */
function renderMissingTool(tool: SetupScan['tools'][number]): string | undefined {
  if (tool.installed) return undefined;
  const how =
    tool.install.kind === 'runnable'
      ? `install it with: ${tool.install.command}`
      : `${tool.install.reason} Install it by hand with: ${tool.install.manualCommand}`;
  return `${tool.label} is not installed; ${how}`;
}

/** The whole scan as words: each tool found, what is missing, the notes, and whether an import may go ahead now. */
export function renderScan(scan: SetupScan): string {
  const lines: string[] = [];
  for (const harness of scan.harnesses) {
    if (harness.installed) lines.push(renderHarnessScan(harness));
  }
  for (const tool of scan.tools) {
    const missing = renderMissingTool(tool);
    if (missing !== undefined) lines.push(missing);
  }
  if (scan.runtimes.length > 0) {
    lines.push(
      'An import would create:',
      ...indent(
        scan.runtimes.map(
          runtime => `${runtime.name}  (${HARNESS_LABEL[runtime.harness]}, profile ${runtime.profile})`,
        ),
      ),
    );
  }
  for (const duplicate of scan.duplicates) {
    lines.push(
      `${duplicate.existing} already uses that ${HARNESS_LABEL[duplicate.harness]} login and profile, so no new runtime would be added.`,
    );
  }
  for (const update of scan.updates) {
    lines.push(`${update.reference} changed in ${update.sources.join(', ')} since the last import.`);
  }
  for (const note of scan.notes) lines.push(`${HARNESS_LABEL[note.harness]}: ${note.text}`);
  const blocked = unavailable(scan.importing);
  if (blocked !== undefined) lines.push(`An import is not possible now: ${blocked}`);
  return lines.join('\n');
}

/** `runtime scan`: what the first run would find, with no question asked and nothing changed. */
export async function runtimeScan(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const scan = await deps.gateway.scan();
  deps.out.report(flagOn(invocation.options, 'json') ? JSON.stringify(scan, null, 2) : renderScan(scan));
}

/** After an import: what to run next, including the sign-in a login that is not signed in still needs. */
function reportNext(deps: AccountCommandDeps, scan: SetupScan, include: readonly HarnessScan['harness'][]): void {
  const bin = deps.binaryName;
  for (const harness of include) {
    const found = scan.harnesses.find(candidate => candidate.harness === harness);
    if (found !== undefined && !signedIn(found))
      deps.out.report(
        `${HARNESS_LABEL[harness]} is not signed in yet: find its login with \`${bin} login ls\`, then run \`${bin} login signin <login>\` before you launch.`,
      );
  }
  deps.out.report(`See what was set up with \`${bin} runtime ls\` and \`${bin} login ls\`.`);
}

/** The scan, refused in words when this machine takes no import now. */
async function openScan(deps: AccountCommandDeps): Promise<SetupScan> {
  await requireMayApply(deps);
  const scan = await deps.gateway.scan();
  const blocked = unavailable(scan.importing);
  if (blocked !== undefined) throw new AccountCommandError(blocked);
  return scan;
}

/**
 * `runtime import claude|codex`: the import with NO questions, for scripts — this tool's own login
 * (shared in place) and setup, under `--name` or the suggested runtime name (`claude-default`).
 *
 * It never installs anything: a tool that is not installed is refused with the way to get it.
 * The question-by-question first run is `onboard`, which Onboarding owns.
 */
export async function runtimeImport(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const harness = parseHarness(positional(invocation, 0, 'tool to import: claude or codex'));
  const bin = deps.binaryName;
  const options: AccountWriteOptions = writeFlags(invocation.options);
  const scan = await openScan(deps);
  const found = scan.harnesses.find(candidate => candidate.harness === harness);
  if (found === undefined || !found.installed) {
    throw new AccountCommandError(
      `${HARNESS_LABEL[harness]} is not installed on ${scan.machine}. Install it with \`${bin} onboard\`, then import it.`,
    );
  }
  for (const duplicate of scan.duplicates) {
    if (duplicate.harness === harness)
      deps.out.report(
        `${duplicate.existing} already uses that ${HARNESS_LABEL[harness]} login and profile, so no new runtime is added.`,
      );
  }
  const name = flagText(invocation.options, 'name');
  const change: AccountChange = {
    kind: 'setup.import',
    include: [harness],
    ...(name === undefined ? {} : { names: { [harness]: name } }),
  };
  const outcome = await runChange(deps, { change, destructive: false, options });
  if (outcome !== undefined && options.json !== true) reportNext(deps, scan, [harness]);
}
