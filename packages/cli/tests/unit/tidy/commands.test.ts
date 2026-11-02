import { describe, it } from 'bun:test';
import type { AgendaActionRequest, AgendaSnapshot, BoardTaskActionRequestInput, TidyPlan } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { registerTidyCommands } from '../../../src/lib/tidy/commands';
import { TidyController } from '../../../src/lib/tidy/controller';

const PLAN: TidyPlan = {
  v: 1,
  sessionId: 'me',
  subFerret: false,
  drop: [{ id: 'F1', title: 'Track the relay work', why: 'the board is off and nobody but you asked for it' }],
  close: [
    { id: 'A1', subject: 'Please test relay', code: 'status-only', why: 'it only reports status' },
    { id: 'A2', subject: 'Card F1 is ready', code: 'card-dropped', why: 'its card &F1 is dropped' },
  ],
  keep: [
    { kind: 'task', id: 'F2', title: 'Owner asked', code: 'owner-asked', why: 'the owner asked for it' },
    {
      kind: 'agenda',
      id: 'A3',
      title: 'Pick a relay',
      code: 'needs-owner',
      why: 'it asks the owner: fy agenda done A3',
    },
  ],
};

const EMPTY: TidyPlan = { ...PLAN, drop: [], close: [], keep: [] };

class Fakes {
  plan: TidyPlan | undefined = PLAN;
  planned: (string | undefined)[] = [];
  drops: { as: string | undefined; id: string; request: BoardTaskActionRequestInput }[] = [];
  closes: { sessionId: string; request: AgendaActionRequest }[] = [];
  failDrop = false;
  failClose: string | undefined;
  lines: string[] = [];

  plans = {
    plan: async (as: string | undefined) => {
      this.planned.push(as);
      return this.plan;
    },
  };
  cards = {
    act: async (as: string | undefined, id: string, request: BoardTaskActionRequestInput) => {
      this.drops.push({ as, id, request });
      if (this.failDrop) throw new Error('refused: nope');
      return {};
    },
  };
  agenda = {
    apply: async (sessionId: string, request: AgendaActionRequest) => {
      this.closes.push({ sessionId, request });
      if (request.action === 'resolve' && request.id === this.failClose) throw 'gone';
      return {} as AgendaSnapshot;
    },
  };
  output = { success: (message: string) => this.lines.push(message), diagnostic: () => {} };
}

function run(argv: string[], fakes = new Fakes(), environmentSessionId: string | undefined = 'me') {
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerTidyCommands(program, new TidyController({ ...fakes, binary: 'fy', environmentSessionId }));
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), fakes };
}

describe('fy tidy', () => {
  it('should print what it would drop, close and keep and change nothing on a dry run', async () => {
    // Arrange
    const { parsed, fakes } = run(['tidy']);

    // Act
    await parsed;

    // Assert
    const text = fakes.lines[0] ?? '';
    should(text).containEql('Dry run: nothing changed.');
    should(text).containEql('Would drop 1 card(s)');
    should(text).containEql('&F1  Track the relay work — the board is off and nobody but you asked for it');
    should(text).containEql('Would close 2 agenda item(s)');
    should(text).containEql('!A1  Please test relay — it only reports status');
    should(text).containEql('Would keep 2');
    should(text).containEql('!A3  Pick a relay');
    should(text).containEql('fy tidy --yes');
    should(fakes.drops).deepEqual([]);
    should(fakes.closes).deepEqual([]);
    should(fakes.planned).deepEqual(['me']);
  });

  it('should say there is nothing to tidy and still show what it kept', async () => {
    // Arrange
    const fakes = new Fakes();
    fakes.plan = { ...EMPTY, keep: PLAN.keep };

    // Act
    await run(['tidy'], fakes).parsed;

    // Assert
    should(fakes.lines[0]).startWith('Nothing to tidy');
    should(fakes.lines[0]).containEql('Kept (2)');
  });

  it('should say only that when there is nothing to tidy and nothing kept', async () => {
    // Arrange
    const fakes = new Fakes();
    fakes.plan = EMPTY;

    // Act
    await run(['tidy'], fakes).parsed;

    // Assert
    should(fakes.lines[0]).equal('Nothing to tidy: no card to drop and no agenda item to close.');
  });

  it('should drop each card and resolve each item with the reason on --yes', async () => {
    // Arrange
    const { parsed, fakes } = run(['tidy', '--yes', '--reason', 'agenda first: board is off']);

    // Act
    await parsed;

    // Assert
    should(fakes.drops).deepEqual([
      { as: 'me', id: 'F1', request: { action: 'drop', reason: 'agenda first: board is off' } },
    ]);
    should(fakes.closes).deepEqual([
      { sessionId: 'me', request: { action: 'resolve', id: 'A1', note: 'agenda first: board is off' } },
      { sessionId: 'me', request: { action: 'resolve', id: 'A2', note: 'agenda first: board is off' } },
    ]);
    should(fakes.lines[0]).containEql('Tidied: dropped 1 card(s), closed 2 agenda item(s).');
    should(fakes.lines[0]).containEql('Kept (2)');
  });

  it('should use a default reason when none is given', async () => {
    // Arrange
    const { parsed, fakes } = run(['tidy', '--yes']);

    // Act
    await parsed;

    // Assert
    should(fakes.drops[0]?.request).match({ action: 'drop', reason: /opt-in/u });
  });

  it('should report each failure, carry on, and exit with an error', async () => {
    // Arrange
    const fakes = new Fakes();
    fakes.failDrop = true;
    fakes.failClose = 'A1';
    const { parsed } = run(['tidy', '--yes'], fakes);

    // Act
    const failure = await parsed.catch((error: unknown) => error);

    // Assert
    should(String(failure)).containEql('2 change(s) failed');
    should(fakes.closes).have.length(2);
    should(fakes.lines[0]).containEql('dropped 0 card(s), closed 1 agenda item(s); 2 failed.');
    should(fakes.lines[0]).containEql('&F1  Track the relay work — FAILED: refused: nope');
    should(fakes.lines[0]).containEql('!A1  Please test relay — FAILED: gone');
  });

  it('should print the plan as JSON on a dry run, and the result with --yes', async () => {
    // Act
    const dry = run(['tidy', '--json']);
    await dry.parsed;
    const applied = run(['tidy', '--yes', '--json']);
    await applied.parsed;

    // Assert
    should(JSON.parse(dry.fakes.lines[0] ?? '{}')).match({ applied: false, plan: { sessionId: 'me' } });
    const result = JSON.parse(applied.fakes.lines[0] ?? '{}') as { applied: boolean; result: { dropped: unknown[] } };
    should(result.applied).be.true();
    should(result.result.dropped).have.length(1);
  });

  it('should act as the --session it is given over the ambient one', async () => {
    // Arrange
    const { parsed, fakes } = run(['tidy', '--session', 's9'], new Fakes(), 'me');

    // Act
    await parsed;

    // Assert
    should(fakes.planned).deepEqual(['s9']);
  });

  it('should refuse when it is not run by a ferret', async () => {
    // Arrange
    const { parsed, fakes } = run(['tidy'], new Fakes(), '');

    // Act
    const failure = await parsed.catch((error: unknown) => error);

    // Assert
    should(String(failure)).containEql('tidies the ferret that runs it');
    should(fakes.planned).deepEqual([]);
  });

  it('should refuse an empty --reason', async () => {
    // Act
    const failure = await run(['tidy', '--yes', '--reason', '  ']).parsed.catch((error: unknown) => error);

    // Assert
    should(String(failure)).containEql('--reason needs words');
  });

  it('should say to update an older daemon that has no tidy route', async () => {
    // Arrange
    const fakes = new Fakes();
    fakes.plan = undefined;

    // Act
    const failure = await run(['tidy'], fakes).parsed.catch((error: unknown) => error);

    // Assert
    should(String(failure)).containEql('fy daemon update');
  });

  it('should render a long title clipped on one line', async () => {
    // Arrange
    const fakes = new Fakes();
    fakes.plan = { ...EMPTY, drop: [{ id: 'F9', title: `${'long '.repeat(40)}\nend`, why: 'because' }] };

    // Act
    await run(['tidy'], fakes).parsed;

    // Assert
    const row = (fakes.lines[0] ?? '').split('\n').find(line => line.includes('&F9')) ?? '';
    should(row).containEql('…');
    should(row).not.containEql('\n');
  });
});
