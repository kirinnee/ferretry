import { dirname, resolve } from 'node:path';
import {
  attachSpawnProvenance,
  DEFAULT_VERDICT_LIMIT,
  mergeWardenReportProvenance,
  newestReportsFirst,
  parseWardenReports,
  parseWardenSpawnProvenance,
  provenancePath,
  reportReadableBy,
  reportsWorthReading,
  reportTargets,
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
   * oracle for a paired browser. */
  async readReportAt(reportPath: string, scope?: WardenReadScope): Promise<string | undefined> {
    const reports = resolve(this.reportsDirectory);
    const candidate = resolve(reportPath);
    if (dirname(candidate) !== reports || !candidate.endsWith('.md')) return undefined;
    return scope === undefined ? await this.readReport(candidate) : await this.readReportFor(candidate, scope);
  }

  /**
   * One report, only when every verdict entry in it is about the scope's lineage; `undefined` otherwise, which is also
   * what a report that does not exist reads as, so a caller cannot tell a stranger's report from a missing one.
   */
  async readReportFor(reportPath: string, scope: WardenReadScope): Promise<string | undefined> {
    const content = await this.files.readText(reportPath).catch(() => undefined);
    if (content === undefined || !reportReadableBy(reportTargets({ path: reportPath, mtimeMs: 0, content }), scope))
      return undefined;
    return mergeWardenReportProvenance(content, await this.readProvenance(reportPath));
  }

  /**
   * The newest report the scope may read (see {@link readReportFor}), with its path. The scan is NEWEST FIRST over every
   * report, not a window: a stranger's newer reports cannot hide the caller's own.
   */
  async newestReportFor(
    files: readonly { readonly path: string; readonly mtimeMs: number }[],
    scope: WardenReadScope,
  ): Promise<{ readonly path: string; readonly content: string } | undefined> {
    const ordered = newestReportsFirst(files);
    for (let from = 0; from < ordered.length; from += SCAN_BATCH) {
      const batch = ordered.slice(from, from + SCAN_BATCH);
      const read = await mapWithConcurrency(batch, async file => await this.readReportFor(file.path, scope));
      const index = read.findIndex(content => content !== undefined);
      const content = read[index];
      const file = batch[index];
      if (content !== undefined && file !== undefined) return { path: file.path, content };
    }
    return undefined;
  }

  /**
   * The most recent verdicts across every report in the directory. For a scope, the most recent verdicts about its
   * lineage: reports are scanned newest first in full, and only a report whose every entry is about the lineage counts,
   * so the limit is applied to what the caller may read and a stranger's reports cannot evict its own.
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

  private async readVerdictsFor(
    ordered: readonly { readonly path: string; readonly mtimeMs: number }[],
    limit: number,
    scope: WardenReadScope,
  ): Promise<readonly (WardenVerdict & { readonly spawn?: WardenVerdictSpawn })[]> {
    const rows: (WardenVerdict & { readonly spawn?: WardenVerdictSpawn })[] = [];
    for (let from = 0; from < ordered.length && rows.length < limit; from += SCAN_BATCH) {
      const loaded = await mapWithConcurrency(ordered.slice(from, from + SCAN_BATCH), async candidate => {
        const content = await this.files.readText(candidate.path).catch(() => undefined);
        return content === undefined || content.trim() === ''
          ? undefined
          : ({ path: candidate.path, mtimeMs: candidate.mtimeMs, content } satisfies WardenReportFile);
      });
      // As for the whole fleet: a report that cannot be read is evidence we cannot safely summarize.
      if (loaded.some(file => file === undefined)) throw new Error('a Warden report could not be read');
      for (const report of loaded) {
        if (report === undefined || !reportReadableBy(reportTargets(report), scope)) continue;
        const provenance = await this.readProvenance(report.path);
        rows.push(
          ...attachSpawnProvenance(
            parseWardenReports([report], limit),
            provenance === undefined ? new Map() : new Map([[report.path, provenance]]),
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
