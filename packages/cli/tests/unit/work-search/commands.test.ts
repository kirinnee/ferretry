import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerWorkSearchCommands } from '../../../src/lib/work-search/commands';
import { WorkSearchController } from '../../../src/lib/work-search/controller';
import { agendaHit, CapturingOutput, FakeWorkSearchGateway, response, taskHit } from './fixtures';

function run(argv: string[], environmentSessionId: string | undefined = undefined, hits = [taskHit(), agendaHit()]) {
  const gateway = new FakeWorkSearchGateway();
  gateway.answer = response(hits);
  const output = new CapturingOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerWorkSearchCommands(
    program,
    new WorkSearchController({ gateway, output, binary: 'fy', environmentSessionId }),
  );
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, output };
}

describe('fy search command surface', () => {
  it('should join the words into one query and print a line per hit', async () => {
    const { parsed, gateway, output } = run(['search', 'relay', 'choice']);

    await parsed;

    should(gateway.searches[0]?.query).containEql({ q: 'relay choice', open: false });
    should(output.lines[0]?.split('\n')).have.length(2);
  });

  it('should pass --kind, --open, --limit and --session through to the search', async () => {
    const { parsed, gateway } = run(
      ['search', 'F303', '--kind', 'task', '--open', '--limit', '5', '--session', 's9'],
      's1',
    );

    await parsed;

    should(gateway.searches[0]).match({ query: { q: 'F303', kind: 'task', open: true, limit: 5 }, as: 's9' });
  });

  it('should look the --project name up before searching', async () => {
    const { parsed, gateway } = run(['search', 'relay', '--project', 'ferretry']);

    await parsed;

    should(gateway.searches[0]?.query.project).be.a.String();
  });

  it('should print the daemon response as JSON with --json', async () => {
    const { parsed, output } = run(['search', 'relay', '--json']);

    await parsed;

    should(JSON.parse(output.lines[0] ?? '{}')).have.property('total', 2);
  });

  it('should say nothing matched when the daemon finds nothing', async () => {
    const { parsed, output } = run(['search', 'zzz'], undefined, []);

    await parsed;

    should(output.lines[0]).match(/No cards or agenda items match/u);
  });

  it('should refuse a missing query, an unknown kind and a bad limit, asking the daemon nothing', async () => {
    const none = run(['search']);
    const kind = run(['search', 'a', '--kind', 'both']);
    const limit = run(['search', 'a', '--limit', '0']);

    await should(none.parsed).be.rejectedWith(/missing required argument/u);
    await should(kind.parsed).be.rejectedWith(/--kind is one of/u);
    await should(limit.parsed).be.rejectedWith(/--limit is a whole number/u);
    should(kind.gateway.searches).be.empty();
    should(limit.gateway.searches).be.empty();
  });
});
