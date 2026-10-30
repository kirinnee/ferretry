import { describe, it } from 'bun:test';
import type { BoardImportSummary } from '@ferretry/protocol';
import should from 'should';
import { BoardImportController, renderImportSummary } from '../../../src/lib/board-import/import-controller';
import type { IBoardImportGateway } from '../../../src/lib/board-import/ports';

const summary = (overrides: Partial<BoardImportSummary> = {}): BoardImportSummary => ({
  dryRun: false,
  skipped: false,
  sessions: 2,
  imported: 3,
  alreadyImported: 1,
  proposedProjects: [],
  linkedAsks: 0,
  untriagedCards: 0,
  problems: [],
  complete: true,
  ...overrides,
});

describe('rendering the import summary', () => {
  it('should say what was done in plain counts', () => {
    const text = renderImportSummary(summary({ imported: 1, alreadyImported: 0, linkedAsks: 2 }));
    should(text).containEql('Board import finished.');
    should(text).containEql('1 task became cards (0 already had one).');
    should(text).containEql('2 agenda items were pointed at a card.');
  });

  it('should say "would" and that nothing changed for a dry run', () => {
    const text = renderImportSummary(summary({ dryRun: true }));
    should(text).containEql('Dry run: nothing was changed.');
    should(text).containEql('3 tasks would become cards');
  });

  it('should mention untriaged cards, proposed projects and every problem', () => {
    const text = renderImportSummary(
      summary({
        untriagedCards: 1,
        proposedProjects: ['unfiled'],
        problems: [
          { sessionId: 's1', taskId: 'F2', detail: 'bad history' },
          { sessionId: 's2', taskId: null, detail: 'unreadable' },
          { sessionId: null, taskId: null, detail: 'the import stopped' },
        ],
      }),
    );
    should(text).containEql('1 Untriaged asks card was made.');
    should(text).containEql('Lanes were proposed for: unfiled.');
    should(text).containEql('Skipped s1 F2: bad history');
    should(text).containEql('Skipped s2: unreadable');
    should(text).containEql('Skipped: the import stopped');
  });
});

describe('the board import controller', () => {
  const harness = (answer: BoardImportSummary) => {
    const asked: boolean[] = [];
    const lines: string[] = [];
    const gateway: IBoardImportGateway = {
      run: dryRun => {
        asked.push(dryRun);
        return Promise.resolve(answer);
      },
    };
    return { asked, lines, controller: new BoardImportController(gateway, { success: line => lines.push(line) }) };
  };

  it('should pass the dry-run flag to the daemon and print the words', async () => {
    const { asked, lines, controller } = harness(summary({ dryRun: true }));
    await controller.run({ dryRun: true, json: false });
    should(asked).eql([true]);
    should(lines[0]).containEql('Dry run');
  });

  it('should print the daemon summary as JSON on request', async () => {
    const { lines, controller } = harness(summary());
    await controller.run({ dryRun: false, json: true });
    should(JSON.parse(lines[0] ?? '')).eql(summary());
  });
});
