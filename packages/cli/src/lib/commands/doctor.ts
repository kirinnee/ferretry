/** `fy doctor` (§3.5 `doctor.checks`, S60): this fy against the daemon, plugin by plugin. */
import { PROTOCOL } from '@ferretry/kernel/contract';
import { judgePlugin, pausedSentence } from '../guard.ts';
import { paneCredentialWarnings, type Environment } from '../credential.ts';
import { EXIT } from '../errors.ts';
import type { PluginInventory } from '../world.ts';
import type { Probe } from '../world.ts';
import type { RegistryEntry } from '../registry.ts';
import type { ShellVerb } from '../shell-context.ts';
import type { VerbConflict } from '../verbs.ts';

export interface Finding {
  readonly state: 'ok' | 'warn' | 'fail';
  readonly title: string;
  readonly detail: string;
  readonly fix?: string;
}

/** How one plugin's `cli` half loaded: skeleton halves are named so nobody mistakes them for a port. */
interface HalfStatus {
  readonly id: string;
  readonly title: string;
  readonly skeleton: boolean;
  readonly error?: string;
}

export interface DoctorInput {
  readonly binary: string;
  readonly probe: Probe;
  /** `undefined` with a reason when the inventory could not be read (no credential, refused). */
  readonly inventory: PluginInventory | { readonly unreadable: string };
  readonly registry: readonly Pick<RegistryEntry, 'id' | 'contract'>[];
  readonly titles: Readonly<Record<string, string>>;
  readonly halves: readonly HalfStatus[];
  readonly conflicts: readonly VerbConflict[];
  readonly environment: Environment;
}

export function diagnose(input: DoctorInput): readonly Finding[] {
  const findings: Finding[] = [];
  const { binary, probe } = input;
  if (probe.state === 'down') {
    findings.push({
      state: 'fail',
      title: 'daemon',
      detail: `not answering at ${probe.baseUrl} (${probe.why})`,
      fix: `${binary} daemon start`,
    });
  } else {
    findings.push({
      state: 'ok',
      title: 'daemon',
      detail: `answering at ${probe.baseUrl}, version ${probe.health.version}`,
    });
    findings.push(
      probe.health.protocol === PROTOCOL
        ? { state: 'ok', title: 'session protocol', detail: `${String(PROTOCOL)}, same as this ${binary}` }
        : {
            state: 'fail',
            title: 'session protocol',
            detail: `the daemon speaks ${String(probe.health.protocol)}, this ${binary} speaks ${String(PROTOCOL)}`,
            fix: probe.health.protocol < PROTOCOL ? `${binary} daemon restart` : `update ${binary}`,
          },
    );
  }
  if ('unreadable' in input.inventory) {
    if (probe.state === 'up')
      findings.push({
        state: 'warn',
        title: 'plugins',
        detail: `the plugin list could not be read: ${input.inventory.unreadable}`,
      });
  } else {
    const inventory = input.inventory;
    const compiled = Object.fromEntries(input.registry.map(entry => [entry.id, entry.contract]));
    for (const entry of input.registry) {
      const verdict = judgePlugin(inventory, compiled, entry.id);
      const title = input.titles[entry.id] ?? entry.id;
      if (verdict.ok) continue;
      findings.push({
        state: verdict.reason === 'off' ? 'warn' : 'fail',
        title: `plugin ${entry.id}`,
        detail: pausedSentence(verdict, title, entry.id, binary),
      });
    }
    const unknown = inventory.plugins.filter(held => compiled[held.id] === undefined).map(held => held.id);
    if (unknown.length > 0)
      findings.push({
        state: 'ok',
        title: 'daemon-only plugins',
        detail: `${unknown.join(', ')} (data plugins, or a newer daemon)`,
      });
    if (!findings.some(finding => finding.title.startsWith('plugin ')))
      findings.push({
        state: 'ok',
        title: 'plugins',
        detail: 'every plugin of this build is present, on and in agreement',
      });
  }
  for (const half of input.halves)
    if (half.error !== undefined)
      findings.push({ state: 'fail', title: `${half.id} commands`, detail: `would not load: ${half.error}` });
  const skeletons = input.halves.filter(half => half.skeleton).map(half => half.id);
  if (skeletons.length > 0)
    findings.push({
      state: 'warn',
      title: 'not built yet',
      detail: `${skeletons.join(', ')} answer "not built yet" in this build`,
    });
  for (const conflict of input.conflicts)
    findings.push({
      state: 'fail',
      title: 'verb conflict',
      detail: `"${conflict.line}" from ${conflict.owner} is left out: ${conflict.keptFrom} already has it`,
    });
  for (const warning of paneCredentialWarnings(input.environment))
    findings.push({ state: 'warn', title: 'credential', detail: warning });
  return findings;
}

const MARK = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' } as const;

export function renderFindings(findings: readonly Finding[]): string {
  return findings
    .map(
      finding =>
        `${MARK[finding.state]}  ${finding.title}: ${finding.detail}${finding.fix === undefined ? '' : `\n      fix: ${finding.fix}`}`,
    )
    .join('\n');
}

export const doctorVerb: ShellVerb = async ctx => {
  const { world } = ctx;
  const probe = await world.probe();
  let inventory: DoctorInput['inventory'] = { unreadable: 'the daemon is not answering' };
  if (probe.state === 'up') {
    try {
      inventory = await (await ctx.deps()).inventory.current();
    } catch (error) {
      inventory = { unreadable: error instanceof Error ? error.message : String(error) };
    }
  }
  const halves: HalfStatus[] = [];
  for (const entry of world.registry.plugins) {
    try {
      halves.push({ id: entry.id, title: entry.manifest.title, skeleton: (await entry.load()).skeleton === true });
    } catch (error) {
      halves.push({
        id: entry.id,
        title: entry.manifest.title,
        skeleton: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const findings = diagnose({
    binary: world.identity.binary,
    probe,
    inventory,
    registry: world.registry.plugins,
    titles: ctx.surfaces.titles,
    halves,
    conflicts: ctx.table.conflicts,
    environment: world.environment,
  });
  world.io.out(`${renderFindings(findings)}\n`);
  return findings.some(finding => finding.state === 'fail') ? EXIT.failure : EXIT.ok;
};
