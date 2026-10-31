import { describe, it } from 'bun:test';
import should from 'should';
import { WorkSearchController } from '../../../src/lib/work-search/controller';
import { CapturingOutput, FakeWorkSearchGateway, agendaHit, response, taskHit } from './fixtures';

const build = (environmentSessionId: string | undefined = undefined) => {
  const gateway = new FakeWorkSearchGateway();
  const output = new CapturingOutput();
  const controller = new WorkSearchController({ gateway, output, binary: 'fy', environmentSessionId });
  return { gateway, output, controller };
};

const refusal = async (work: () => Promise<unknown>): Promise<string> => {
  const failure = await work().then(
    () => undefined,
    (error: unknown) => error,
  );
  should((failure as Error).name).equal('CliInputError');
  return (failure as Error).message;
};

describe('fy search', () => {
  it('should print one line per hit with the card and agenda shapes', async () => {
    // Arrange
    const { controller, gateway, output } = build();
    gateway.answer = response([taskHit(), agendaHit()]);

    // Act
    await controller.search(['relay', 'choice'], {});

    // Assert
    should(gateway.searches[0]?.query).containEql({ q: 'relay choice', open: false });
    const lines = output.lines[0]?.split('\n') ?? [];
    should(lines).have.length(2);
    should(lines[0]).match(/^&F303\s+task\s+In progress\s+Work search — make search easy and fast$/u);
    should(lines[1]).match(/^!A3\s+agenda\s+open \(mvgt2oz9 lizzette\)\s+Pick a relay$/u);
  });

  it('should say what matched nothing, naming the kind asked about', async () => {
    // Arrange
    const { controller, output } = build();

    // Act
    await controller.search(['nothing'], {});
    await controller.search(['nothing'], { kind: 'agenda' });

    // Assert
    should(output.lines).eql(['No cards or agenda items match “nothing”.', 'No agenda items match “nothing”.']);
  });

  it('should pass kind, open and limit through, and act as the ambient session', async () => {
    // Arrange
    const { controller, gateway } = build('sess-a');

    // Act
    await controller.search(['x'], { kind: ' Task ', open: true, limit: '5' });
    await controller.search(['x'], { session: 'sess-b' });

    // Assert
    should(gateway.searches[0]).eql({ query: { q: 'x', kind: 'task', open: true, limit: 5 }, as: 'sess-a' });
    should(gateway.searches[1]?.as).equal('sess-b');
  });

  it('should resolve a project by name', async () => {
    // Arrange
    const { controller, gateway } = build();

    // Act
    await controller.search(['x'], { project: 'ferretry' });

    // Assert
    should(gateway.searches[0]?.query.project).be.a.String();
    should(await refusal(() => controller.search(['x'], { project: 'nope' }))).match(/no project "nope"/u);
  });

  it('should label the caller’s own work with the command that updates it', async () => {
    // Arrange
    const { controller, gateway, output } = build('mvgt2oz9-1111aaaa');
    gateway.answer = response([agendaHit()]);

    // Act
    await controller.search(['relay'], {});

    // Assert
    should(output.lines[0]).containEql('(yours — fy agenda edit A3)');
  });

  it('should print the daemon’s answer as JSON on request', async () => {
    // Arrange
    const { controller, gateway, output } = build();
    gateway.answer = response([taskHit()]);

    // Act
    await controller.search(['x'], { json: true });

    // Assert
    should(JSON.parse(output.lines[0] ?? '').hits[0].id).equal('F303');
  });

  it('should say when there are more hits than shown', async () => {
    // Arrange
    const { controller, gateway, output } = build();
    gateway.answer = response([taskHit()], 9);

    // Act
    await controller.search(['x'], {});

    // Assert
    should(output.lines[0]).containEql('Showing 1 of 9');
  });

  it('should refuse a blank query, a bad kind and a bad limit before asking the daemon', async () => {
    // Arrange
    const { controller, gateway } = build();

    // Act + Assert
    should(await refusal(() => controller.search(['  '], {}))).match(/say what to look for/u);
    should(await refusal(() => controller.search(['x'], { kind: 'both' }))).match(/--kind is one of task \| agenda/u);
    should(await refusal(() => controller.search(['x'], { limit: '0' }))).match(/--limit/u);
    should(await refusal(() => controller.search(['x'], { limit: '51' }))).match(/--limit/u);
    should(gateway.searches).eql([]);
  });
});
