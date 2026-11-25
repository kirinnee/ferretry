import type { WardenArtifacts } from './sweep.ts';

/** How many filed reports are remembered at once: a day of investigations is far fewer. The oldest is forgotten first. */
export const FILED_REPORTS_REMEMBERED = 512;

/**
 * The artifacts, reading a report only until it is FILED.
 *
 * Reading a report is what files an investigator's summary (`FileWardenArtifacts.readReport`), and a filed report is
 * never replaced. The sweep reads every finished investigation's report for a day, so without this every one of them cost
 * two file reads on every sweep long after its report was filed. A read that finds a report remembers it and answers
 * the same text next time; a read that finds none is asked again, because the summary may land after the session stops.
 */
export function onceFiled(artifacts: WardenArtifacts): WardenArtifacts {
  const filed = new Map<string, string>();
  return {
    writeProvenance: async (reportPath, provenance) => await artifacts.writeProvenance(reportPath, provenance),
    latest: async () => await artifacts.latest(),
    reportPath: (at, targetId) => artifacts.reportPath(at, targetId),
    readReport: async reportPath => {
      const held = filed.get(reportPath);
      if (held !== undefined) return held;
      const report = await artifacts.readReport(reportPath);
      if (report === undefined) return undefined;
      if (filed.size >= FILED_REPORTS_REMEMBERED) filed.delete(filed.keys().next().value as string);
      filed.set(reportPath, report);
      return report;
    },
  };
}
