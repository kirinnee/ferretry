import { dirname, resolve } from 'node:path';
import {
  attachSpawnProvenance,
  DEFAULT_VERDICT_LIMIT,
  mergeWardenReportProvenance,
  parseWardenReports,
  parseWardenSpawnProvenance,
  provenancePath,
  reportsWorthReading,
  type WardenReportFile,
  type WardenReportFileSystem,
  type WardenSpawnProvenance,
  type WardenVerdict,
  type WardenVerdictSpawn,
} from '../../lib/warden/index.ts';
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
  async readReportAt(reportPath: string): Promise<string | undefined> {
    const reports = resolve(this.reportsDirectory);
    const candidate = resolve(reportPath);
    if (dirname(candidate) !== reports || !candidate.endsWith('.md')) return undefined;
    return await this.readReport(candidate);
  }

  /** The most recent verdicts across every report in the directory. */
  async readVerdicts(
    limit = DEFAULT_VERDICT_LIMIT,
  ): Promise<readonly (WardenVerdict & { readonly spawn?: WardenVerdictSpawn })[]> {
    const candidates = reportsWorthReading(await this.files.listFiles(this.reportsDirectory), limit);

    const loaded = await mapWithConcurrency(candidates, async candidate => {
      const content = await this.files.readText(candidate.path).catch(() => undefined);
      // An empty or unreadable report carries no verdict and would only occupy
      // a row. One bad file must not blank the list.
      return content === undefined || content.trim() === ''
        ? undefined
        : ({ path: candidate.path, mtimeMs: candidate.mtimeMs, content } satisfies WardenReportFile);
    });
    const reports = loaded.filter((file): file is WardenReportFile => file !== undefined);

    const provenance = new Map<string, WardenSpawnProvenance>();
    await mapWithConcurrency(reports, async report => {
      const spawn = await this.readProvenance(report.path);
      if (spawn !== undefined) provenance.set(report.path, spawn);
    });

    return attachSpawnProvenance(parseWardenReports(reports, limit), provenance);
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
