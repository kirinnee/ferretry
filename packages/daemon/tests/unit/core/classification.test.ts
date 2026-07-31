import { describe, it } from 'bun:test';
import should from 'should';
import { classifyTask, describeClassification } from '../../../src/lib/core/index.ts';

describe('classifyTask', () => {
  it.each([
    { task: 'rename 40 call sites across every file', expected: 'bulk-chore' },
    { task: 'migrate the store to the new schema', expected: 'migration' },
    { task: 'review this diff before it lands', expected: 'review' },
    { task: 'investigate how the scheduler works', expected: 'research' },
    { task: 'the upload keeps crashing on retry', expected: 'debugging' },
    { task: 'tidy the dashboard component css', expected: 'frontend' },
    { task: 'add an endpoint to the worker queue', expected: 'backend' },
    { task: 'tidy things up a bit', expected: 'general' },
  ])('should read "$task" as $expected work', ({ task, expected }) => {
    // Arrange / Act
    const classification = classifyTask(task);

    // Assert
    should(classification.kind).equal(expected);
  });

  it('should refuse to call demanding work mechanical just because it says rename', () => {
    // Arrange / Act
    const classification = classifyTask('mechanically rename every call site of the concurrent scheduler');

    // Assert
    should(classification.complexity).equal('hard');
  });

  it('should read a plain rename as mechanical', () => {
    // Arrange / Act
    const classification = classifyTask('rename the helper');

    // Assert
    should(classification.complexity).equal('mechanical');
    should(classification.risk).equal('low');
  });

  it('should default to mid complexity with no signal either way', () => {
    // Arrange / Act
    const classification = classifyTask('add a button');

    // Assert
    should(classification.complexity).equal('mid');
    should(classification.risk).equal('normal');
  });

  it('should treat a chore with no complexity words as mechanical', () => {
    // Arrange / Act
    const classification = classifyTask('touch each file in turn');

    // Assert
    should(classification.kind).equal('bulk-chore');
    should(classification.complexity).equal('mechanical');
  });

  it('should raise risk to critical on a security-shaped request', () => {
    // Arrange / Act
    const classification = classifyTask('rotate the production credential');

    // Assert
    should(classification.risk).equal('critical');
  });

  it.each([
    { label: 'size words', task: 'touch 30 packages', expected: 'large' },
    { label: 'reach words', task: 'update the whole codebase', expected: 'large' },
    { label: 'a short brief', task: 'fix the label', expected: 'small' },
  ])('should size a request from $label', ({ task, expected }) => {
    // Arrange / Act
    const classification = classifyTask(task);

    // Assert
    should(classification.size).equal(expected);
  });

  it('should read a long brief with no size words as medium scope', () => {
    // Arrange
    const task = `add the field and wire it through. ${'more prose '.repeat(60)}`;

    // Act
    const classification = classifyTask(task);

    // Assert
    should(classification.size).equal('medium');
  });

  it('should call ambiguity low once a plan is in hand', () => {
    // Arrange / Act
    const classification = classifyTask('rewrite the protocol layer, following the plan');

    // Assert
    should(classification.complexity).equal('hard');
    should(classification.ambiguity).equal('low');
  });

  it('should call hard work ambiguous when no plan is mentioned', () => {
    // Arrange / Act
    const classification = classifyTask('rewrite the protocol layer');

    // Assert
    should(classification.ambiguity).equal('high');
  });

  it('should call an open question ambiguous even when it is small', () => {
    // Arrange / Act
    const classification = classifyTask('figure out the right shape');

    // Assert
    should(classification.ambiguity).equal('high');
  });

  it('should treat a mass chore as unambiguous work', () => {
    // Arrange / Act
    const classification = classifyTask('refactor every file in the repo');

    // Assert
    should(classification.kind).equal('bulk-chore');
    should(classification.ambiguity).equal('low');
  });

  it.each([
    { label: 'said so', task: 'polish the customer onboarding copy' },
    { label: 'is frontend work', task: 'restyle the landing dashboard' },
  ])('should mark work product-facing when it $label', ({ task }) => {
    // Arrange / Act
    const classification = classifyTask(task);

    // Assert
    should(classification.productFacing).be.true();
  });

  it('should record the words behind every axis', () => {
    // Arrange / Act
    const classification = classifyTask('debug the flaky production test');

    // Assert
    const risk = classification.evidence.find(item => item.axis === 'risk');
    should(risk?.value).equal('critical');
    should(risk?.matched).containEql('production');
  });
});

describe('describeClassification', () => {
  it('should quote the evidence it used', () => {
    // Arrange / Act
    const described = describeClassification(classifyTask('debug the flaky production test'));

    // Assert
    should(described).containEql('critical risk');
    should(described).containEql('production');
  });

  it('should say plainly when nothing in the request signalled anything', () => {
    // Arrange / Act
    const described = describeClassification(classifyTask('do the thing'));

    // Assert
    should(described).containEql('no strong keyword signal, defaults applied');
  });
});
