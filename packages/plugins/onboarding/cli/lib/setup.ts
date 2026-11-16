/**
 * `daemon setup`: the first run at a terminal, ONE QUESTION AT A TIME (v4's words and order): install what is missing,
 * then for each tool found "use your login and setup?", then each runtime's name, then ONE reviewed `setup.import`
 * change that imports what was chosen.
 *
 * It never re-implements the import: it calls the routes Runtimes serves to the app (the machine, the scan, a staged
 * proposal, its apply, the tool install) and asks the questions. It needs a person: with nobody to ask it refuses and
 * names `daemon import <tool>`, the no-questions verb for scripts. A login or secret is never asked for or printed: the
 * scan carries names only, and a signed-out tool is signed in afterwards with `login signin`.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type AccountChange,
  AccountChangeOutcomeSchema,
  AccountChangeRequestSchema,
  type AccountChangeView,
  AccountChangeViewSchema,
  type HarnessScan,
  MachineViewSchema,
  ProposalApplyRequestSchema,
  type SetupScan,
  SetupScanSchema,
  ToolInstallRequestSchema,
  ToolInstallResultSchema,
} from '@ferretry/plugin-runtimes/contract';
import type { OnboardOutput, OnboardPrompt } from './ports.ts';

type Harness = HarnessScan['harness'];

/** The routes Runtimes declares for the app; the client refuses any that no manifest declares. */
const ROUTES = {
  machine: 'GET /v1/runtimes/machine',
  scan: 'GET /v1/runtimes/setup/scan',
  install: 'POST /v1/runtimes/machine/tools/install',
  propose: 'POST /v1/runtimes/proposals',
  apply: 'POST /v1/runtimes/proposals/:proposalId/apply',
} as const;

const LABEL: Record<Harness, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

export interface SetupFlags {
  readonly dryRun: boolean;
  readonly json: boolean;
}

export interface SetupDeps {
  readonly client: PluginClient;
  /** Absent when nobody can be asked. */
  readonly prompt: OnboardPrompt | undefined;
  readonly out: OnboardOutput;
  readonly bin: string;
}

const REFUSALS = {
  'not-granted': "This caller is not allowed to change this machine's setup: the operator has not granted it.",
  'device-not-granted':
    "This device has not been given permission to change this machine's setup. Grant it at the machine with `device grant`, or from a device that holds it.",
  'step-up-required':
    'This change needs a passkey confirmation from a paired device, which a command line cannot give. Make it from the app, or run this on the machine itself.',
  undetermined: "This machine's grant settings could not be read, so no change is allowed until they are fixed.",
  granted: "This caller is not allowed to change this machine's setup.",
} as const;

/** A refusal said in words, with exit 1 (a daemon error is said the same way). */
class Refusal extends Error {}

const signedIn = (scan: HarnessScan): boolean =>
  scan.account.state === 'signed-in' || scan.account.state === 'refresh-due';

const list = (items: readonly string[]): string => (items.length === 0 ? 'none' : items.join(', '));

/** What the first run found for one tool, before anybody chooses. Names only, never a value. */
export function renderHarnessScan(scan: HarnessScan): string {
  const { account } = scan;
  const login =
    account.state === 'signed-in' || account.state === 'refresh-due'
      ? `signed in${account.email ? ` as ${account.email}` : ''}`
      : account.state.replace(/-/gu, ' ');
  const lines = [
    `Your login: ${login}`,
    ...(scan.instructions === undefined ? [] : [`Instructions: ${scan.instructions.source}`]),
    ...(scan.settings === undefined
      ? []
      : [`Settings: ${scan.settings.source} (${scan.settings.count} setting(s), ${scan.settings.hooks} hook(s))`]),
    `MCP servers: ${list(scan.mcpServers)}`,
    `Skills: ${list(scan.skills)}`,
    ...(scan.secretKeys.length === 0
      ? []
      : [`Moved to the secret store, never copied as text: ${scan.secretKeys.join(', ')}`]),
    ...scan.missingCommands.map(command => `Command not found on this machine: ${command}`),
    ...scan.problems.map(problem => `Problem: ${problem}`),
  ];
  return [LABEL[scan.harness], ...lines.map(line => `  ${line}`)].join('\n');
}

/** What a staged change would do, for the person deciding whether to apply it. */
function renderChangeView(view: AccountChangeView): string {
  const lines = [view.summary, ...view.consequences.map(sentence => `  • ${sentence}`)];
  if (view.preview.kind === 'apply' && view.preview.runtimes.length > 0)
    lines.push(
      'Runtimes after this change:',
      ...view.preview.runtimes.map(
        runtime =>
          `  ${runtime.name} (${LABEL[runtime.harness]}${runtime.agent ? ', agent' : ''}) — ${runtime.launch.available ? 'ready to launch' : runtime.launch.reason}`,
      ),
    );
  return lines.join('\n');
}

/** How an applied change ended, and whether a script should trust it as done. */
function renderOutcome(outcome: ReturnType<typeof AccountChangeOutcomeSchema.parse>): { text: string; ok: boolean } {
  if (outcome.outcome === 'executed') return { ok: true, text: outcome.summary };
  if (outcome.outcome !== 'applied') return { ok: false, text: 'The change did not apply as a setup import.' };
  const { apply } = outcome;
  if (apply.outcome === 'committed') return { ok: true, text: 'Done.' };
  if (apply.outcome === 'committed-with-history-failure')
    return {
      ok: false,
      text: `Saved, but the shared ${apply.failedHarness} history could not be set up: ${apply.reason}`,
    };
  return { ok: false, text: `${apply.failedOperation} failed: ${apply.reason}` };
}

/** Drives `daemon setup`. Returns the exit code. */
export async function runDaemonSetup(deps: SetupDeps, flags: SetupFlags): Promise<number> {
  const { out, prompt, bin } = deps;
  if (prompt === undefined) {
    out.warn(
      `\`${bin} daemon setup\` asks a few questions, so it needs a terminal. In a script, run \`${bin} daemon import claude\` or \`${bin} daemon import codex\` instead.`,
    );
    return 1;
  }
  try {
    return await interview(deps, prompt, flags);
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    out.warn(error.message);
    return 1;
  }
}

const askYes = async (prompt: OnboardPrompt, question: string): Promise<boolean> => {
  const answer = (await prompt.ask(`${question} [Y/n]`)).trim().toLowerCase();
  return answer === '' || answer === 'y' || answer === 'yes';
};

/** A yes/no that defaults to NO: an update to a component somebody may have edited is offered, never assumed. */
const askNo = async (prompt: OnboardPrompt, question: string): Promise<boolean> => {
  const answer = (await prompt.ask(`${question} [y/N]`)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
};

async function openScan(client: PluginClient): Promise<SetupScan> {
  const { authority } = MachineViewSchema.parse(await client.call(ROUTES.machine));
  if (!authority.mayApply) throw new Refusal(REFUSALS[authority.applyRefusal]);
  const scan = SetupScanSchema.parse(await client.call(ROUTES.scan));
  if (!scan.importing.available) throw new Refusal(scan.importing.reason);
  return scan;
}

/** Installs the tools the person agreed to, saying the command first; a failure names the command to run by hand. */
async function installMissing(deps: SetupDeps, scan: SetupScan, missing: readonly Harness[]): Promise<void> {
  for (const tool of scan.tools)
    if (!tool.installed && missing.includes(tool.harness))
      deps.out.report(
        tool.install.kind === 'runnable'
          ? `${tool.label} will be installed with: ${tool.install.command}`
          : `${tool.label} cannot be installed from here: ${tool.install.reason}\n  Run it yourself: ${tool.install.manualCommand}`,
      );
  deps.out.report('Installing… this can take a few minutes.');
  const body = ToolInstallRequestSchema.parse({ harnesses: [...missing] });
  const result = ToolInstallResultSchema.parse(await deps.client.call(ROUTES.install, { body }));
  for (const outcome of result.outcomes) {
    if (outcome.outcome === 'failed')
      deps.out.warn(
        `${LABEL[outcome.harness]} was not installed: ${outcome.reason}\n  Run it yourself: ${outcome.manualCommand}`,
      );
    else deps.out.report(`${LABEL[outcome.harness]} is installed.`);
  }
}

async function interview(deps: SetupDeps, prompt: OnboardPrompt, flags: SetupFlags): Promise<number> {
  const { client, out, bin } = deps;
  let scan = await openScan(client);

  // Tools come first, and only on a machine that has no setup yet: Import again is about what changed.
  if (scan.format === 'none') {
    const missing = scan.tools.filter(tool => !tool.installed).map(tool => tool.harness);
    if (missing.length > 0 && !flags.dryRun) {
      const label = missing.map(harness => LABEL[harness]).join(' and ');
      if (await askYes(prompt, `${label} ${missing.length === 1 ? 'is' : 'are'} not installed. Install now?`)) {
        await installMissing(deps, scan, missing);
        scan = SetupScanSchema.parse(await client.call(ROUTES.scan));
      }
    }
  }

  const include: Harness[] = [];
  for (const harness of scan.harnesses) {
    if (!harness.installed) continue;
    out.report(renderHarnessScan(harness));
    const name = LABEL[harness.harness];
    if (!signedIn(harness))
      out.report(`Your ${name} login is not signed in. You can still import it, and sign in afterwards.`);
    if (await askYes(prompt, `We found ${name} on ${scan.machine}. Use your login and setup?`))
      include.push(harness.harness);
  }
  for (const note of scan.notes) out.report(`${LABEL[note.harness]}: ${note.text}`);

  const acceptedUpdates: string[] = [];
  for (const update of scan.updates)
    if (
      await askNo(
        prompt,
        `${update.reference} changed in ${update.sources.join(', ')} since the last import. Update it?`,
      )
    )
      acceptedUpdates.push(update.reference);

  if (include.length === 0 && acceptedUpdates.length === 0) {
    out.report(
      scan.format === 'none'
        ? `Nothing was set up, so ${scan.machine} has no runtimes yet. Run \`${bin} daemon setup\` again when you are ready, or finish in the app.`
        : 'Nothing was imported. Your runtimes are unchanged.',
    );
    return 0;
  }

  const names: Partial<Record<Harness, string>> = {};
  for (const runtime of scan.runtimes) {
    if (!include.includes(runtime.harness)) continue;
    const answer = (await prompt.ask(`Name for the ${LABEL[runtime.harness]} runtime [${runtime.name}]:`)).trim();
    if (answer !== '') names[runtime.harness] = answer;
  }
  for (const duplicate of scan.duplicates)
    if (include.includes(duplicate.harness))
      out.report(
        `${duplicate.existing} already uses that ${LABEL[duplicate.harness]} login and profile, so no new runtime is added.`,
      );

  const change: AccountChange = {
    kind: 'setup.import',
    include,
    ...(Object.keys(names).length === 0 ? {} : { names }),
    ...(acceptedUpdates.length === 0 ? {} : { acceptedUpdates }),
  };
  const view = AccountChangeViewSchema.parse(
    await client.call(ROUTES.propose, { body: AccountChangeRequestSchema.parse({ change }) }),
  );
  if (!flags.json) out.report(renderChangeView(view));
  if (flags.dryRun) {
    out.report(flags.json ? JSON.stringify({ change: view }, null, 2) : 'Dry run: nothing was changed.');
    return 0;
  }
  const outcome = AccountChangeOutcomeSchema.parse(
    await client.call(ROUTES.apply, { params: { proposalId: view.id }, body: ProposalApplyRequestSchema.parse({}) }),
  );
  const rendered = renderOutcome(outcome);
  if (flags.json) out.report(JSON.stringify({ change: view, outcome }, null, 2));
  else if (rendered.ok) out.report(rendered.text);
  else out.warn(rendered.text);
  if (!rendered.ok) return 1;
  if (!flags.json) reportNext(deps, scan, include);
  return 0;
}

/** After an import: what to run next, including the sign-in a login that is not signed in still needs. */
function reportNext(deps: SetupDeps, scan: SetupScan, include: readonly Harness[]): void {
  for (const harness of include) {
    const found = scan.harnesses.find(candidate => candidate.harness === harness);
    if (found !== undefined && !signedIn(found))
      deps.out.report(
        `${LABEL[harness]} is not signed in yet: find its login with \`${deps.bin} login ls\`, then run \`${deps.bin} login signin <login>\` before you launch.`,
      );
  }
  deps.out.report(`See what was set up with \`${deps.bin} runtime ls\` and \`${deps.bin} login ls\`.`);
}
