/**
 * Decisions about which report files to read and how a provenance sidecar is
 * folded into a report. The reading itself lives in the adapter.
 */

import type { WardenFileInfo } from './ports.ts';
import { renderProvenanceMarkdown, type WardenSpawnProvenance } from './provenance.ts';
import type { WardenVerdict } from './verdicts.ts';

export const REPORT_EXTENSION = '.md';

/** Never open fewer than this many reports, however small the requested limit,
 *  so a single multi-anomaly file cannot hide older sessions from the list. */
export const MINIMUM_REPORTS_READ = 40;

/**
 * The report files worth opening for a verdict list of `limit` rows: markdown
 * only, newest first, and more than `limit` because one file can produce many
 * rows or none at all. Ties break on path so the same directory always yields
 * the same reading order.
 */
export function reportsWorthReading(files: readonly WardenFileInfo[], limit: number): readonly WardenFileInfo[] {
  if (limit <= 0) return [];
  return files
    .filter(file => file.path.endsWith(REPORT_EXTENSION))
    .toSorted((left, right) =>
      left.mtimeMs === right.mtimeMs ? left.path.localeCompare(right.path) : right.mtimeMs - left.mtimeMs,
    )
    .slice(0, Math.max(MINIMUM_REPORTS_READ, limit * 2));
}

/** Provenance as the API surfaces it: the recorded facts, plus the reason the
 *  configured first choice was passed over when this launch failed over. */
export type WardenVerdictSpawn = WardenSpawnProvenance & { readonly failoverReason?: string };

export function verdictSpawn(provenance: WardenSpawnProvenance): WardenVerdictSpawn {
  if (!provenance.failedOver) return provenance;
  const failoverReason = provenance.skipped[provenance.configuredFirst];
  return failoverReason === undefined ? provenance : { ...provenance, failoverReason };
}

/** Attach spawn facts to the verdicts whose report has a valid sidecar. */
export function attachSpawnProvenance(
  verdicts: readonly WardenVerdict[],
  provenance: ReadonlyMap<string, WardenSpawnProvenance>,
): readonly (WardenVerdict & { readonly spawn?: WardenVerdictSpawn })[] {
  return verdicts.map(verdict => {
    const spawn = provenance.get(verdict.reportPath);
    return spawn === undefined ? verdict : { ...verdict, spawn: verdictSpawn(spawn) };
  });
}

/**
 * A human-facing report with its provenance block on top.
 *
 * The block is prepended at READ time and never persisted into the file: the
 * verdict parser must see the model's own words only, or the rendered block's
 * vocabulary would feed the prose heuristics.
 */
export function mergeWardenReportProvenance(content: string, provenance?: WardenSpawnProvenance): string {
  return provenance === undefined ? content : `${renderProvenanceMarkdown(provenance)}\n\n${content}`;
}
