import { basename, join } from 'node:path';
import {
  REPORT_EXTENSION,
  provenancePath,
  reportsWorthReading,
  type WardenArtifacts,
  type WardenReportFileSystem,
  type WardenSpawnProvenance,
} from '../../lib/warden/index.ts';
import type { WardenReportReader } from './report-reader.ts';

/** How many leading lines of a report the status surface shows. Enough to carry
 *  the verdict line and the recommendation under it, which is what an operator
 *  glancing at `warden status` actually needs. */
export const REPORT_HEAD_LINES = 12;

/**
 * Where a warden's evidence lives on disk.
 *
 * THE REPORT PATH IS DERIVED FROM THE INSTANT, not a counter, because it has to be
 * decided BEFORE the warden exists: the path goes into the warden's own prompt, so
 * it can be told exactly where to write. A per-target suffix keeps two assigned
 * wardens spawned in the same millisecond apart, and the colons and dots an ISO
 * instant carries are replaced because they are not portable in filenames.
 *
 * THE PROVENANCE SIDECAR IS WRITTEN, NEVER MERGED INTO THE REPORT. `reports.ts`
 * prepends the rendered provenance block at READ time and says why: the verdict
 * parser must see the model's own words only, or the block's vocabulary would feed
 * the prose heuristics that classify the verdict.
 */
export class FileWardenArtifacts implements WardenArtifacts {
  constructor(
    private readonly files: WardenReportFileSystem,
    private readonly reader: WardenReportReader,
    private readonly reportsDirectory: string,
  ) {}

  reportPath(at: string, targetId?: string): string {
    const stamp = at.replaceAll(/[:.]/gu, '-');
    return join(this.reportsDirectory, `${stamp}${targetId === undefined ? '' : `-${targetId}`}${REPORT_EXTENSION}`);
  }

  async writeProvenance(reportPath: string, provenance: WardenSpawnProvenance): Promise<void> {
    await this.files.writeTextAtomic(provenancePath(reportPath), `${JSON.stringify(provenance, null, 2)}\n`);
  }

  /** The report a finished warden left, with its provenance block on top. */
  async readReport(reportPath: string): Promise<string | undefined> {
    return await this.reader.readReport(reportPath);
  }

  /**
   * The newest report, identified by its FILENAME rather than its absolute path.
   *
   * The path names a directory inside the operator's state home, and this value is
   * served on a route a warden-scoped token can read. The filename is the whole
   * identity a caller needs to ask for the report again.
   *
   * Newest is decided by modification time through the same ordering the verdict
   * list uses, so "the latest report" means the same thing on both surfaces — a
   * filename sort would disagree the moment a report was rewritten.
   */
  async latest(): Promise<{ readonly reportId: string; readonly head: string } | undefined> {
    const files = await this.files.listFiles(this.reportsDirectory);
    const newest = reportsWorthReading(files, 1)[0];
    if (newest === undefined) return undefined;
    const content = await this.reader.readReport(newest.path);
    if (content === undefined) return undefined;
    return { reportId: basename(newest.path), head: content.split('\n').slice(0, REPORT_HEAD_LINES).join('\n') };
  }
}
