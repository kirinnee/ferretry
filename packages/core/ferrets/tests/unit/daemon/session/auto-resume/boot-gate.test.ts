import { describe, it } from 'bun:test';
import should from 'should';
import { BootPassGate, sharedBootPass } from '../../../../../daemon/lib/session/auto-resume/boot-gate.ts';

describe('boot pass gate', () => {
  it('should start closed to the observers and open once the boot pass releases it', () => {
    // Arrange
    const gate = new BootPassGate();

    // Act
    const before = gate.open;
    gate.release();

    // Assert
    should(before).equal(false);
    should(gate.open).equal(true);
  });

  it('should treat a second release as the first and stay open', () => {
    // Arrange
    const gate = new BootPassGate();

    // Act
    gate.release();
    gate.release();

    // Assert
    should(gate.open).equal(true);
  });

  it('should make the gate once and hand the same object to whichever feature asks next', () => {
    // Arrange
    const late: { bootPass?: BootPassGate } = {};

    // Act
    const first = sharedBootPass(late);
    const second = sharedBootPass(late);

    // Assert
    should(first).be.instanceOf(BootPassGate);
    should(second).equal(first);
    should(late.bootPass).equal(first);
  });

  it('should share one release between the two features that hold the gate', () => {
    // Arrange
    const late: { bootPass?: BootPassGate } = {};
    const forAutoResume = sharedBootPass(late);
    const forTurnWatch = sharedBootPass(late);

    // Act
    forAutoResume.release();

    // Assert
    should(forTurnWatch.open).equal(true);
  });

  it('should reuse a gate that was already registered instead of replacing it', () => {
    // Arrange
    const existing = new BootPassGate();
    const late: { bootPass?: BootPassGate } = { bootPass: existing };

    // Act
    const shared = sharedBootPass(late);

    // Assert
    should(shared).equal(existing);
  });
});
