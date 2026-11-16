import { defineState } from '@ferretry/kernel/contract';

/**
 * `auto-resume.json` (F-0109, today's `FY_HOME/auto-resume.json`): the ferrets a host restart took down that are still
 * owed an auto-resume, written BEFORE any is attempted. `auto-resume-summary.json` (F-0108): what the last pass did.
 * Each adapter parses its own body and reads an unreadable one as empty (the safe direction: nobody is resumed).
 */
export const AutoResumeFile = defineState({ name: 'auto-resume', path: 'auto-resume.json', store: 'json', format: 1 });
export const AutoResumeSummaryFile = defineState({
  name: 'auto-resume-summary',
  path: 'auto-resume-summary.json',
  store: 'json',
  format: 1,
});
