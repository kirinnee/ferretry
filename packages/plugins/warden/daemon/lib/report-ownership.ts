/**
 * Whose report is this, decided STRICTLY enough to hand its raw bytes to a ferret.
 *
 * `parseWardenReports` is a best-effort reader of LLM-authored markdown: it accepts template drift, and a section it does
 * not recognise is silently dropped. That is right for a UI summary and wrong for an authorization decision, because a
 * parser that ignores a section cannot vouch for the bytes it ignored. This module is the separate, fail-closed check
 * a FERRET reader's access rests on (the owner and a person never go through it).
 *
 * A report is readable by a lineage only when EVERY part of it is attributable to that lineage:
 *
 * - **Fleet triage** (it has `## Anomaly` sections): every heading that mentions an anomaly is a well-formed
 *   `## Anomaly: <session-id> …` line naming a session in the lineage; no other `##` section exists; no assigned header.
 * - **Assigned** (one `# Warden report — <session-id>` header): exactly one such header, well formed, naming a session
 *   in the lineage; no anomaly heading. The daemon names the file `<instant>-<session-id>.md` and writes a provenance
 *   sidecar with the same `target`; when either is present it must AGREE with the header.
 * - **Anything else** (a pack report, a headless report, an empty file, an ambiguous mix) belongs to no caller.
 * - **Whatever the structure says, no session identity outside the lineage appears anywhere in the text**: an id-shaped
 *   token that is not the lineage's (the Warden session that wrote it excepted) fails the report closed.
 *
 * Pure: every input is a value.
 */
import type { WardenReadScope } from './ferret-view.ts';

/** What the daemon itself recorded about a report, next to the text: it is authoritative where the text is not. */
export interface WardenReportFacts {
  /** The report's file name. */
  readonly path: string;
  readonly content: string;
  /** The provenance sidecar's `target` (an assigned report), when a sidecar survived validation. */
  readonly provenanceTarget?: string;
  /** The provenance sidecar's `wardenSessionId`: the Warden session that wrote the report, which the text may name. */
  readonly provenanceWarden?: string;
}

/** A session id as the daemon issues them (`<base36>-<hex>`), found anywhere in running text. */
const SESSION_ID_TOKEN = /\b[a-z0-9]+-[0-9a-f]{6,}\b/gi;

/** Any heading that so much as mentions an anomaly, at any level. */
const ANOMALY_HEADING = /^[^\S\n]{0,3}#{1,6}[^\S\n]*anomal/gim;
/** The one well-formed spelling of an anomaly section heading, on a single line. */
const STRICT_ANOMALY_HEADING =
  /^##[^\S\n]+Anomaly:[^\S\n]*(?:`([^`\n]+)`|([A-Za-z0-9._-]+))(?:[^\S\n]*(?:—|–|-)[^\n]*)?[^\S\n]*$/gm;
/** Any heading that so much as mentions a Warden report header, at any level. */
const REPORT_HEADER = /^[^\S\n]{0,3}#{1,6}[^\S\n]*warden[^\S\n]+report/gim;
/** The one well-formed assigned header, on a single line. */
const STRICT_REPORT_HEADER =
  /^#[^\S\n]+Warden report[^\S\n]*(?:—|-)[^\S\n]*([A-Za-z0-9._-]+)(?:[^\S\n]*\([^\n)]*\))?[^\S\n]*$/gm;
/** Every second-level heading. */
const SECTION_HEADING = /^##(?!#)/gm;

/** Session id embedded in an assigned report filename `<instant>-<sessionId>.md`. */
const FILENAME_SESSION = /Z-([a-z0-9]+-[0-9a-f]{6,})\.md$/i;

const count = (pattern: RegExp, text: string): number => [...text.matchAll(pattern)].length;

/** The id of a strict anomaly heading match. */
const strictIds = (content: string): readonly string[] =>
  [...content.matchAll(STRICT_ANOMALY_HEADING)].map(match => (match[1] ?? match[2] ?? '').trim());

/** Whether the lineage may read this report, every part of it attributable to the lineage. Fails closed. */
export function reportOwnedBy(report: WardenReportFacts, scope: WardenReadScope): boolean {
  const { content } = report;
  if (content.trim() === '') return false;

  // No identity outside the lineage anywhere in the text, whatever its structure.
  for (const token of content.match(SESSION_ID_TOKEN) ?? [])
    if (token !== report.provenanceWarden && !scope.mayRead(token)) return false;

  const anomalyHeadings = count(ANOMALY_HEADING, content);
  const headerMentions = count(REPORT_HEADER, content);

  if (anomalyHeadings > 0) {
    // Fleet triage. Every mention is a well-formed section for a session in the lineage, and nothing else is a section.
    if (headerMentions > 0) return false;
    const ids = strictIds(content);
    if (ids.length !== anomalyHeadings || count(SECTION_HEADING, content) !== ids.length) return false;
    if (ids.some(id => id === '' || !scope.mayRead(id))) return false;
    // A fleet report has no single target: a sidecar that names one disagrees with it.
    return report.provenanceTarget === undefined;
  }

  // Assigned: exactly one well-formed header.
  if (headerMentions !== 1) return false;
  const headers = [...content.matchAll(STRICT_REPORT_HEADER)].map(match => (match[1] ?? '').trim());
  const target = headers[0];
  if (headers.length !== 1 || target === undefined || target === '' || !scope.mayRead(target)) return false;
  const named = FILENAME_SESSION.exec(report.path)?.[1];
  if (named !== undefined && named !== target) return false;
  return report.provenanceTarget === undefined || report.provenanceTarget === target;
}

/**
 * The session an assigned report is FOR, from the daemon's own file name, before the file is opened; `undefined` for a
 * fleet-triage report (`<instant>.md`), whose targets live only in its text. A scoped scan reads no report whose name
 * puts it outside the lineage, so what such a report holds cannot change what the scope is told.
 */
export function reportNamedFor(path: string): string | undefined {
  return FILENAME_SESSION.exec(path)?.[1];
}
