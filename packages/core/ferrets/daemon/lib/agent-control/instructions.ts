import type { FerretId } from '../../../contract/index.ts';
import { instructionsReport, renderInstructionsReport } from '../../../contract/instructions-report.ts';

/**
 * Today's `instructions` tool: which of its own sections THIS ferret launched with, and how the owner turns each on.
 * The answer is for the ferret the session credential names, from the PERSISTED launch environment
 * (`LaunchEnvironmentStore`, the one reader) — the same variables the wrapper composed its prompt from, so it cannot
 * disagree with what the launch did, and a restart changes nothing. A caller that is no ferret, or one whose launch
 * recorded no switches, gets today's own sentences for those cases.
 */
export async function instructionsAnswer(
  ferret: FerretId | undefined,
  launched: (ferret: FerretId) => Promise<Readonly<Record<string, string>>>,
  binary: string,
): Promise<{ readonly text: string }> {
  if (ferret === undefined) return { text: renderInstructionsReport(instructionsReport({}), binary) };
  return {
    text: renderInstructionsReport(instructionsReport({ ...(await launched(ferret)), FY_SESSION_ID: ferret }), binary),
  };
}
