import type { BoardImportSummary } from '@ferretry/protocol';
import type { IBoardImportGateway, IBoardImportOutput } from './ports';

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The summary in words, the problems last so they are what the eye lands on. */
export const renderImportSummary = (summary: BoardImportSummary): string => {
  const dry = summary.dryRun;
  const lines = [
    summary.dryRun ? 'Dry run: nothing was changed.' : 'Board import finished.',
    `${plural(summary.imported, 'task')} ${dry ? 'would become' : 'became'} cards (${summary.alreadyImported} already had one).`,
    `${plural(summary.linkedAsks, 'agenda item')} ${dry ? 'would be' : 'were'} pointed at a card.`,
  ];
  if (summary.untriagedCards > 0)
    lines.push(`${plural(summary.untriagedCards, 'Untriaged asks card')} ${dry ? 'would be' : 'was'} made.`);
  if (summary.proposedProjects.length > 0) {
    lines.push(`Lanes ${dry ? 'would be' : 'were'} proposed for: ${summary.proposedProjects.join(', ')}.`);
  }
  for (const problem of summary.problems) {
    const where = [problem.sessionId, problem.taskId].filter(part => part !== null).join(' ');
    lines.push(`Skipped${where === '' ? '' : ` ${where}`}: ${problem.detail}`);
  }
  return lines.join('\n');
};

/** `board import [--dry-run]`: runs the one-time import of the old per-session task files, or previews it. */
export class BoardImportController {
  constructor(
    private readonly gateway: IBoardImportGateway,
    private readonly output: IBoardImportOutput,
  ) {}

  async run(options: { readonly dryRun: boolean; readonly json: boolean }): Promise<void> {
    const summary = await this.gateway.run(options.dryRun);
    this.output.success(options.json ? JSON.stringify(summary, null, 2) : renderImportSummary(summary));
  }
}
