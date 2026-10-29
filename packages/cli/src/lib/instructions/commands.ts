import type { Command } from 'commander';
import { instructionsReport, renderInstructionsReport } from './report.ts';

/** The narrowest slice of the shipped `ConsoleIo` this command uses. */
export interface InstructionsOutput {
  success(message: string): void;
}

/**
 * Mounts `fy instructions`: which of its own system-prompt sections — Hypermedia, Pack mode, Lessons —
 * the ferret this runs inside launched with, and how the owner turns each one on. The `instructions`
 * MCP tool answers the same report.
 */
export function registerInstructionsCommands(
  program: Command,
  environment: Readonly<Record<string, string | undefined>>,
  out: InstructionsOutput,
  binary: string,
): void {
  program
    .command('instructions')
    .description('show which Ferretry sections (hypermedia, Pack mode, agenda mode, lessons) this ferret launched with')
    .option('--json', 'print the report as JSON')
    .action((options: { readonly json?: boolean }) => {
      const report = instructionsReport(environment);
      out.success(options.json === true ? JSON.stringify(report, null, 2) : renderInstructionsReport(report, binary));
    });
}
