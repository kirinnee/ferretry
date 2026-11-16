import { instructionsReport, renderInstructionsReport } from '../../contract/instructions-report.ts';
import { on } from '../lib/verb-io.ts';
import { BINARY, defineVerbs } from './context.ts';

export default defineVerbs(({ env, verb }) => ({
  instructions: verb(async (invocation, presenter) => {
    const report = instructionsReport(env ?? {});
    if (on(invocation, 'json')) presenter.json(report);
    else presenter.lines([renderInstructionsReport(report, BINARY)]);
  }),
}));
