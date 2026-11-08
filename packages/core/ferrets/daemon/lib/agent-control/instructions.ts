import type { FerretId } from '../../../contract/index.ts';
import { instructionsReport, renderInstructionsReport } from '../../../contract/instructions-report.ts';

/**
 * Today's `instructions` tool: which of its own sections THIS ferret launched with, and how the owner turns each on.
 * The answer is for the ferret the session credential names, from the switches its launch recorded
 * (`FerretsService.launchedSwitches`) — the same variables the wrapper composed its prompt from, so it cannot disagree
 * with what the launch did. A caller that is no ferret, or one this daemon did not launch, gets today's own sentences
 * for those cases.
 */
export function instructionsAnswer(
  ferret: FerretId | undefined,
  launched: (ferret: FerretId) => Readonly<Record<string, string>> | undefined,
  binary: string,
): { readonly text: string } {
  if (ferret === undefined) return { text: renderInstructionsReport(instructionsReport({}), binary) };
  return { text: renderInstructionsReport(instructionsReport({ FY_SESSION_ID: ferret, ...launched(ferret) }), binary) };
}
