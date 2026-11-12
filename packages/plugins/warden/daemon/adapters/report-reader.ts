import { dirname, resolve } from 'node:path';
import {
  attachSpawnProvenance,
  DEFAULT_VERDICT_LIMIT,
  mergeWardenReportProvenance,
  newestReportsFirst,
  parseWardenReports,
  parseWardenSpawnProvenance,
  provenancePath,
  reportNamedFor,
  reportsWorthReading,
  type WardenReadScope,
  type WardenReportFile,
  type WardenReportFileSystem,
  type WardenSpawnProvenance,
  type WardenVerdict,
  type WardenVerdictSpawn,
} from '../lib/index.ts';
import { mapWithConcurrency } from './concurrent.ts';

/**
 * Reads warden reports and their provenance sidecars off disk and hands the
 * pure parser the text it needs.
 *
 * A sidecar that is missing, unreadable JSON, or fails its schema degrades to
 * "no provenance" rather than failing the read. Provenance is decoration on a
 * report the warden already wrote; letting a corrupt sidecar take the whole
 * verdict list down would turn a cosmetic fault into an outage of the very
 * surface that shows the fleet is unhealthy.
 */
export class WardenReportReader {
  constructor(
    private readonly files: WardenReportFileSystem,
    private readonly reportsDirectory: string,
  ) {}

  /** The provenance recorded for one report, if any survives validation. */
  async readProvenance(reportPath: string): Promise<WardenSpawnProvenance | undefined> {
    const raw = await this.files.readText(provenancePath(reportPath)).catch(() => undefined);
    if (raw === undefined) return undefined;
    return parseWardenSpawnProvenance(safeJson(raw));
  }

  /** One report as a human should see it: the markdown with its provenance
   *  block on top. `undefined` when the report does not exist. */
  async readReport(reportPath: string): Promise<string | undefined> {
    const content = await this.files.readText(reportPath);
    if (content === undefined) return undefined;
    return mergeWardenReportProvenance(content, await this.readProvenance(reportPath));
  }

  /** Read one exact report from this daemon's evidence directory. A verdict row
   * may carry a path, but this read surface must never become an arbitrary-file
   * oracle for a paired browser. The owner's and a person's: a FERRET is never
   * served a report (the route refuses it before it gets here). */
  async readReportAt(reportPath: string): Promise<string | undefined> {
    const reports = resolve(this.reportsDirectory);
    const candidate = resolve(reportPath);
    if (dirname(candidate) !== reports || !candidate.endsWith('.md')) return undefined;
    return await this.readReport(candidate);
  }

  /**
   * The most recent verdicts across every report in the directory. For a scope, the most recent verdicts ABOUT its
   * lineage: reports are scanned newest first in full and only the entries whose target is in the lineage count, so the
   * limit is applied to what the caller may read and a stranger's reports cannot evict its own.
   */
  async readVerdicts(
    limit = DEFAULT_VERDICT_LIMIT,
    scope?: WardenReadScope,
  ): Promise<readonly (WardenVerdict & { readonly spawn?: WardenVerdictSpawn })[]> {
    const listed = await this.files.listFiles(this.reportsDirectory);
    if (scope !== undefined) return await this.readVerdictsFor(newestReportsFirst(listed), limit, scope);
    const candidates = reportsWorthReading(listed, limit);

    const loaded = await mapWithConcurrency(candidates, async candidate => {
      const content = await this.files.readText(candidate.path).catch(() => undefined);
      // An empty or unreadable report carries no verdict and would only occupy
      // a row. One bad file must not blank the list.
      return content === undefined || content.trim() === ''
        ? undefined
        : ({ path: candidate.path, mtimeMs: candidate.mtimeMs, content } satisfies WardenReportFile);
    });
    // A candidate that cannot be read is evidence we cannot safely summarize.
    // The mounted route turns this into an unavailable index, rather than a
    // deceptively quiet empty history.
    if (loaded.some(file => file === undefined)) throw new Error('a Warden report could not be read');
    const reports = loaded.filter((file): file is WardenReportFile => file !== undefined);

    const provenance = new Map<string, WardenSpawnProvenance>();
    await mapWithConcurrency(reports, async report => {
      const spawn = await this.readProvenance(report.path);
      if (spawn !== undefined) provenance.set(report.path, spawn);
    });

    return attachSpawnProvenance(parseWardenReports(reports, limit), provenance);
  }

  /**
   * The scope's verdicts, newest report first, filtered by lineage BEFORE anything is cut. A report whose name puts it
   * outside the lineage is never opened; one whose name does not say whose it is (a fleet triage) is opened, contributes
   * only the entries whose target is in the lineage, and when it cannot be read it is simply not the scope's, so no
   * report the scope may not read can change a row, an error or a banner. A report named for the lineage that cannot be
   * read is the scope's own and fails the read, as it does for the owner.
   *
   * What a FERRET is then shown of a row is only its target, classification and times (`ferretVerdictsView`): the
   * entry's prose is a model's and never leaves, so a target's being read out of a model's heading carries no more than
   * which of the caller's own ferrets the row is about.
   */
  private async readVerdictsFor(
    ordered: readonly { readonly path: string; readonly mtimeMs: number }[],
    limit: number,
    scope: WardenReadScope,
  ): Promise<readonly (WardenVerdict & { readonly spawn?: WardenVerdictSpawn })[]> {
    const rows: (WardenVerdict & { readonly spawn?: WardenVerdictSpawn })[] = [];
    const candidates = ordered.filter(candidate => {
      const named = reportNamedFor(candidate.path);
      return named === undefined || scope.mayRead(named);
    });
    for (let from = 0; from < candidates.length && rows.length < limit; from += SCAN_BATCH) {
      const loaded = await mapWithConcurrency(candidates.slice(from, from + SCAN_BATCH), async candidate => {
        const content = await this.files.readText(candidate.path).catch(() => undefined);
        return {
          candidate,
          report:
            content === undefined || content.trim() === ''
              ? undefined
              : ({ path: candidate.path, mtimeMs: candidate.mtimeMs, content } satisfies WardenReportFile),
        };
      });
      // The scope's OWN report (named for it) that cannot be read is evidence we cannot safely summarize.
      if (loaded.some(entry => entry.report === undefined && reportNamedFor(entry.candidate.path) !== undefined))
        throw new Error('a Warden report could not be read');
      for (const { report } of loaded) {
        if (report === undefined) continue;
        // Parse the WHOLE report, narrow it to the lineage, and only then cut: a fleet report whose many foreign
        // sections come first must not push the caller's own row out of a limit that counts what it may read.
        rows.push(
          ...parseWardenReports([report], Number.POSITIVE_INFINITY).filter(
            verdict => verdict.targetSession !== undefined && scope.mayRead(verdict.targetSession),
          ),
        );
        if (rows.length >= limit) break;
      }
    }
    return rows.slice(0, limit);
  }
}

/** How many reports a scoped scan opens at once; it stops at the first batch that completes the answer. */
const SCAN_BATCH = 40;

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
