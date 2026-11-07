import { describe, it } from 'bun:test';
import should from 'should';
import { renderRecommendation } from '../../../../cli/lib/fleet/render.ts';
import { fakeWorld, recommendation, runVerb } from './account-fakes.ts';

describe('recommend', () => {
  it('should join the task from the words given and probe quota by default', async () => {
    // Arrange
    const world = fakeWorld();

    // Act
    await runVerb(world, 'recommend', ['port', 'the', 'CLI', 'groups']);

    // Assert
    should(world.gateway.called('recommend')[0]?.args[0]).eql({ task: 'port the CLI groups', usage: true });
    should(world.out.text('success')).containEql('pick  codex');
  });

  it('should collapse the whitespace a shell leaves behind', async () => {
    const world = fakeWorld();
    await runVerb(world, 'recommend', ['  port ', ' the  CLI ']);
    should(world.gateway.called('recommend')[0]?.args[0]).match({ task: 'port the CLI' });
  });

  it('should skip the probe under --no-usage', async () => {
    const world = fakeWorld();
    await runVerb(world, 'recommend', ['anything'], { usage: false });
    should(world.gateway.called('recommend')[0]?.args[0]).match({ usage: false });
  });

  it('should refuse an empty task rather than asking the daemon to guess', async () => {
    const world = fakeWorld();
    await should(runVerb(world, 'recommend', ['   '])).be.rejectedWith(
      'describe the task: fz recommend "<what needs doing>"',
    );
    should(world.gateway.called('recommend')).be.empty();
  });

  it('should emit the recommendation under --json', async () => {
    const world = fakeWorld();
    await runVerb(world, 'recommend', ['anything'], { json: true });
    should(JSON.parse(world.out.text('success'))).have.property('roles');
  });
});

describe('renderRecommendation', () => {
  it('should print every alternative, what was skipped and every warning beside the pick', () => {
    const text = renderRecommendation(
      recommendation({
        exclusions: [{ accountId: 'codex-spare', agent: 'codex', reason: 'out of quota' }],
        warnings: ['quota inputs were not read'],
      }),
    );
    should(text)
      .match(/implementer: the work is mostly writing modules with tests/)
      .and.match(/pick {2}codex \(gpt-5\.6, account claude-you\): expensive, but holds the whole unit/)
      .and.match(/or {4}claude-code \(opus, account claude-you\): cheaper, shorter context/)
      .and.match(/not considered:\n {4}codex \(codex-spare\): out of quota/)
      .and.match(/! quota inputs were not read/);
  });

  it('should show a classification that is not a sentence as its JSON', () => {
    should(renderRecommendation(recommendation({ classification: { shape: 'build' } }))).match(
      /\{"shape":"build"\} — /,
    );
  });
});
