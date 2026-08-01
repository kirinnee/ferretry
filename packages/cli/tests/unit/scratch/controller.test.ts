import { describe, it } from 'bun:test';
import should from 'should';
import { ScratchController } from '../../../src/lib/scratch/controller.ts';
import { CapturingOutput, eligiblePlan, RecordingScratchGateway, retainedPlan } from './fixtures.ts';

function controller(gateway = new RecordingScratchGateway()) {
  const out = new CapturingOutput();
  return { subject: new ScratchController(gateway, out), gateway, out };
}

describe('scratch planning', () => {
  it('should render eligible entries and retained reasons without deleting', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.execute({ dryRun: true, limit: 7 });

    // Assert
    should(gateway.limits).eql([7]);
    should(gateway.forces).be.empty();
    should(out.messages[0]).containEql('FREE  session-free');
    should(out.messages[0]).containEql('cache/');
    should(out.messages[0]).containEql('keep  session-live');
    should(out.messages[0]).containEql('(session is still active)');
    should(out.messages[0]).containEql('would free 2.5 MB from 1 session(s)');
  });

  it('should use the protocol default limit and emit the plan as JSON', async () => {
    // Arrange
    const gateway = new RecordingScratchGateway([eligiblePlan()]);
    const { subject, out } = controller(gateway);

    // Act
    await subject.execute({ dryRun: true, json: true });

    // Assert
    should(gateway.limits).eql([20]);
    should(JSON.parse(out.messages[0] ?? '')).deepEqual([eligiblePlan()]);
  });

  it('should reject invalid dry-run limits before contacting the daemon', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act + Assert
    await should(subject.execute({ dryRun: true, limit: 0 })).be.rejectedWith('--limit must be a positive integer');
    await should(subject.execute({ dryRun: true, limit: 1.5 })).be.rejectedWith('--limit must be a positive integer');
    should(gateway.limits).be.empty();
  });
});

describe('scratch sweeping', () => {
  it('should sweep without an override by default', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.execute({});

    // Assert
    should(gateway.forces).eql([false]);
    should(out.messages).eql(['reclaimed 2.5 MB from 1 session(s)']);
  });

  it('should pass the daemon-supported config override and retain partial failures', async () => {
    // Arrange
    const gateway = new RecordingScratchGateway([], { sessions: 2, bytes: 1_000_000_000, failures: 3 });
    const { subject, out } = controller(gateway);

    // Act
    await subject.execute({ force: true });

    // Assert
    should(gateway.forces).eql([true]);
    should(out.messages[0]).equal(
      'reclaimed 1.0 GB from 2 session(s); 3 entr(ies) could not be removed (see daemon log)',
    );
  });

  it('should emit the sweep result as JSON', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.execute({ json: true });

    // Assert
    should(JSON.parse(out.messages[0] ?? '')).deepEqual({ sessions: 1, bytes: 2_500_000, failures: 0 });
  });
});

describe('scratch byte rendering', () => {
  it('should render kilobyte-scale plans and omitted teammate names', async () => {
    // Arrange
    const gateway = new RecordingScratchGateway([retainedPlan()]);
    const { subject, out } = controller(gateway);

    // Act
    await subject.execute({ dryRun: true });

    // Assert
    should(out.messages[0]).containEql('2 kB');
    should(out.messages[0]).containEql('would free 0 kB from 0 session(s)');
  });
});
