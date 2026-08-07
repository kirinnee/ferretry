/**
 * The evidence artifact: what a reviewer reads instead of taking a green tick's
 * word for it.
 *
 * IT IS WRITTEN WHETHER THE PROOF PASSES OR FAILS, and the CI step that uploads it
 * runs `if: always()` for the same reason — a red run is the run whose facts matter
 * most, and a failure that leaves nothing behind costs a whole CI cycle to
 * reproduce.
 *
 * IT IS BOUNDED. Every string is clipped, the request ledger is capped, and the two
 * documents are written as separate files rather than embedded, so a runaway
 * diagram or a hostile-looking bundle cannot turn the artifact into something
 * nobody can open. Nothing here can carry a secret: the whole journey runs against
 * a loopback server it started itself, with no credential, no token and no
 * environment capture.
 *
 * IT RECORDS THE ENGINE IT ACTUALLY DROVE. The browser name and version come from
 * the session's negotiated capabilities, never from the job's name — so a run
 * against something that is not Safari cannot be read as Safari evidence.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FyRenderJourneyProperty } from '../../tests/fixtures/fy-render-journey.ts';
import type { LedgerEntry } from './ledger.ts';

export interface PropertyResult {
  readonly id: string;
  readonly title: string;
  /** The rule, copied from the shared journey definition. */
  readonly verdict: string;
  readonly outcome: 'pass' | 'fail';
  /** The facts that decided it, each one readable on its own. */
  readonly evidence: readonly string[];
}

export interface ProofReport {
  readonly startedAt: string;
  readonly durationMs: number;
  readonly platform: string;
  readonly browserName: string;
  readonly browserVersion: string;
  readonly driverPath: string;
  readonly driverVersion: string;
  readonly harnessOrigin: string;
  /** Every hash in the generated policy, and the probe document's substitution. */
  readonly shell: {
    readonly policy: string;
    readonly scriptHashes: readonly string[];
    readonly bootstrapHash: string;
    readonly probePolicy: string;
    readonly probeScriptHash: string;
    readonly deployedHeaders: readonly (readonly [string, string])[];
    readonly detachedHeaders: readonly string[];
  };
  readonly steps: readonly { readonly step: string; readonly ok: boolean; readonly observations: unknown }[];
  readonly ledger: readonly LedgerEntry[];
  readonly ledgerTruncated: boolean;
  readonly properties: readonly PropertyResult[];
  readonly failures: readonly string[];
  readonly ok: boolean;
  /** Things a green run does NOT establish. Written into the artifact on purpose. */
  readonly notProven: readonly string[];
}

const LEDGER_CAP = 500;
const STRING_CAP = 2_000;

const clip = (value: string): string => (value.length > STRING_CAP ? `${value.slice(0, STRING_CAP)}…[clipped]` : value);

/** Recursively bounds a report's strings so no single field can dominate the file. */
const bounded = (value: unknown): unknown => {
  if (typeof value === 'string') return clip(value);
  if (Array.isArray(value)) return value.slice(0, 200).map(bounded);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bounded(item)]));
  return value;
};

const table = (report: ProofReport): string =>
  report.properties
    .map(property => `| ${property.outcome === 'pass' ? '✅' : '❌'} | \`${property.id}\` | ${property.title} |`)
    .join('\n');

const detail = (report: ProofReport): string =>
  report.properties
    .map(property =>
      [
        `### ${property.outcome === 'pass' ? '✅' : '❌'} ${property.id}`,
        '',
        property.title,
        '',
        `**Rule.** ${property.verdict}`,
        '',
        ...property.evidence.map(fact => `- ${fact}`),
      ].join('\n'),
    )
    .join('\n\n');

const markdown = (report: ProofReport): string =>
  [
    `# fy-render sandbox shell — ${report.browserName} ${report.browserVersion}`,
    '',
    report.ok ? '**Every property passed.**' : `**${report.failures.length} property/properties failed.**`,
    '',
    `- Platform: \`${report.platform}\``,
    `- Driver: \`${report.driverPath}\` — ${report.driverVersion}`,
    `- Harness origin: \`${report.harnessOrigin}\``,
    `- Duration: ${(report.durationMs / 1000).toFixed(1)} s`,
    '',
    '## The document that was measured',
    '',
    'The generated production shell, byte for byte. The probe document is the same bytes with one',
    'script and one hash substituted; both are written next to this file.',
    '',
    '```',
    report.shell.policy,
    '```',
    '',
    `Bootstrap hash: \`${report.shell.bootstrapHash}\``,
    '',
    `Probe bootstrap hash: \`${report.shell.probeScriptHash}\``,
    '',
    '### Headers taken from the deployed `_headers` rule',
    '',
    ...report.shell.deployedHeaders.map(([name, value]) => `- \`${name}: ${value}\``),
    '',
    `Detached by the rule: ${report.shell.detachedHeaders.map(name => `\`${name}\``).join(', ')}`,
    '',
    '## Properties',
    '',
    '| | id | property |',
    '| --- | --- | --- |',
    table(report),
    '',
    detail(report),
    '',
    '## Ordered request ledger',
    '',
    'Every request the harness server received, in arrival order. `Sec-Fetch-*` values are recorded',
    'where the engine sends them and are never asserted — Safari sends none.',
    '',
    '| seq | ms | method | path | class | probe |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.ledger.map(
      entry =>
        `| ${entry.seq} | ${entry.atMs} | ${entry.method} | \`${entry.path}\` | ${entry.classification} | ${entry.probe ?? ''} |`,
    ),
    report.ledgerTruncated ? `\n_The ledger was truncated at ${LEDGER_CAP} entries._` : '',
    '',
    '## What a green run does NOT establish',
    '',
    ...report.notProven.map(limit => `- ${limit}`),
    '',
  ].join('\n');

export interface ArtifactPaths {
  readonly directory: string;
  readonly generatedShell: string;
  readonly probeShell: string;
}

export const writeReport = async (
  paths: ArtifactPaths,
  report: ProofReport,
  documents: { readonly generatedShell: string; readonly probeShell: string; readonly driverLog: string },
): Promise<void> => {
  await mkdir(paths.directory, { recursive: true });
  const capped: ProofReport = {
    ...report,
    ledger: report.ledger.slice(0, LEDGER_CAP),
    ledgerTruncated: report.ledger.length > LEDGER_CAP,
    steps: bounded(report.steps) as ProofReport['steps'],
  };
  await writeFile(join(paths.directory, 'report.json'), `${JSON.stringify(capped, null, 2)}\n`, 'utf8');
  await writeFile(join(paths.directory, 'report.md'), markdown(capped), 'utf8');
  await writeFile(paths.generatedShell, documents.generatedShell, 'utf8');
  await writeFile(paths.probeShell, documents.probeShell, 'utf8');
  await writeFile(join(paths.directory, 'driver.log'), documents.driverLog, 'utf8');
};

/**
 * Pairs each journey property with the outcome a driver computed for it, and fails
 * when the two sets disagree.
 *
 * A property nobody scored is a silent hole exactly the size of the thing it was
 * meant to measure, and a scored id that is in no journey definition means the two
 * have drifted. Both are errors here rather than omissions in the artifact.
 */
export const collectProperties = (
  journey: readonly FyRenderJourneyProperty[],
  scored: ReadonlyMap<string, { readonly outcome: 'pass' | 'fail'; readonly evidence: readonly string[] }>,
): readonly PropertyResult[] => {
  const missing = journey.filter(property => !scored.has(property.id)).map(property => property.id);
  if (missing.length > 0) throw new Error(`❌ the driver scored no outcome for: ${missing.join(', ')}`);
  const unknown = [...scored.keys()].filter(id => !journey.some(property => property.id === id));
  if (unknown.length > 0)
    throw new Error(`❌ the driver scored ids that are in no journey definition: ${unknown.join(', ')}`);
  return journey.map(property => {
    const result = scored.get(property.id);
    return {
      evidence: result?.evidence ?? [],
      id: property.id,
      outcome: result?.outcome ?? 'fail',
      title: property.title,
      verdict: property.verdict,
    };
  });
};
