import { describe, it } from 'bun:test';
import should from 'should';
import { RecommendController } from '../../../src/lib/fleet/recommend';
import { CapturingOutput, RecordingRecommendationGateway } from './fixtures';

function controller(binaryName = 'fy') {
  const recommendations = new RecordingRecommendationGateway();
  const out = new CapturingOutput();
  return { subject: new RecommendController({ recommendations, out, binaryName }), recommendations, out };
}

describe('recommending a team', () => {
  it('should join the task from the words given and probe quota by default', async () => {
    // Arrange
    const { subject, recommendations, out } = controller();

    // Act
    await subject.recommend(['port', 'the', 'CLI', 'groups'], {});

    // Assert
    should(recommendations.requests).eql([{ task: 'port the CLI groups', usage: true }]);
    should(out.text).containEql('pick  sol');
  });

  it('should collapse the whitespace a shell leaves behind', async () => {
    // Arrange
    const { subject, recommendations } = controller();

    // Act
    await subject.recommend(['  port ', ' the  CLI '], {});

    // Assert
    should(recommendations.requests[0]?.task).equal('port the CLI');
  });

  it('should skip the probe under --no-usage', async () => {
    // Arrange
    const { subject, recommendations } = controller();

    // Act
    await subject.recommend(['anything'], { usage: false });

    // Assert
    should(recommendations.requests[0]?.usage).be.false();
  });

  it('should refuse an empty task rather than asking the daemon to guess', async () => {
    // Arrange
    const { subject, recommendations } = controller('foo');

    // Act + Assert — the example names the binary it was given, so a rename never strands it.
    await should(subject.recommend(['   '], {})).be.rejectedWith(
      'describe the task: foo fleet recommend "<what needs doing>"',
    );
    should(recommendations.requests).be.empty();
  });

  it('should emit the recommendation under --json', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.recommend(['anything'], { json: true });

    // Assert
    should(JSON.parse(out.text)).have.property('roles');
  });
});
