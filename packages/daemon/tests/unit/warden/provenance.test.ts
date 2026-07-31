import { describe, it } from 'bun:test';
import should from 'should';
import {
  buildWardenSpawnProvenance,
  parseWardenSpawnProvenance,
  provenancePath,
  renderProvenanceMarkdown,
  type WardenSelectionProvenance,
  type WardenSpawnFacts,
} from '../../../src/lib/warden/index.ts';

const facts: WardenSpawnFacts = {
  sessionId: 'wd-1',
  createdAt: '2026-07-30T12:00:00.000Z',
  agent: 'reserve-account',
  harness: 'claude',
  model: 'sample-model-2',
  modelSource: 'harness',
};

const preferred: WardenSelectionProvenance = {
  policy: 'fallback',
  selection: 'preferred',
  configuredFirst: 'reserve-account',
  skipped: {},
};

const failedOver: WardenSelectionProvenance = {
  policy: 'fallback',
  selection: 'failover',
  configuredFirst: 'primary-account',
  skipped: { 'primary-account': 'at its weekly limit' },
};

describe('warden spawn provenance', () => {
  it('should record the account that actually ran', () => {
    // Arrange / Act
    const provenance = buildWardenSpawnProvenance(facts, preferred);

    // Assert
    should(provenance.agent).eql('reserve-account');
    should(provenance.wardenSessionId).eql('wd-1');
    should(provenance.at).eql('2026-07-30T12:00:00.000Z');
    should(provenance.failedOver).be.false();
    should(provenance.target).be.undefined();
  });

  it('should attach the target of an assigned warden', () => {
    // Arrange / Act
    const provenance = buildWardenSpawnProvenance(facts, preferred, 'session-42');

    // Assert
    should(provenance.target).eql('session-42');
  });

  it('should derive failover from the selection evidence', () => {
    // Arrange / Act
    const provenance = buildWardenSpawnProvenance(facts, failedOver);

    // Assert
    should(provenance.failedOver).be.true();
  });

  it.each([
    {
      label: 'a rotation under round robin',
      selection: {
        policy: 'round_robin' as const,
        selection: 'rotation' as const,
        configuredFirst: 'primary-account',
        skipped: {},
      },
    },
    {
      label: 'a failover that landed back on the configured first choice',
      selection: {
        policy: 'fallback' as const,
        selection: 'failover' as const,
        configuredFirst: 'reserve-account',
        skipped: {},
      },
    },
  ])('should not call $label a failover', ({ selection }) => {
    // Arrange / Act
    const provenance = buildWardenSpawnProvenance(facts, selection);

    // Assert
    should(provenance.failedOver).be.false();
  });

  it('should copy the skipped reasons rather than alias the caller map', () => {
    // Arrange
    const skipped: Record<string, string> = { 'primary-account': 'at its weekly limit' };
    const provenance = buildWardenSpawnProvenance(facts, { ...failedOver, skipped });

    // Act
    skipped['primary-account'] = 'mutated afterwards';

    // Assert
    should(provenance.skipped['primary-account']).eql('at its weekly limit');
  });

  it('should name the sidecar next to its report', () => {
    // Arrange / Act / Assert
    should(provenancePath('/state/warden/reports/2026.md')).eql('/state/warden/reports/2026.md.meta.json');
  });
});

describe('warden provenance parsing', () => {
  it('should accept a payload it produced itself', () => {
    // Arrange
    const provenance = buildWardenSpawnProvenance(facts, failedOver, 'session-42');

    // Act
    const parsed = parseWardenSpawnProvenance(JSON.parse(JSON.stringify(provenance)));

    // Assert
    should(parsed).eql(provenance);
  });

  it.each([
    { label: 'a non-object', value: 'nope' },
    { label: 'null', value: null },
    { label: 'an array', value: [] },
    { label: 'a future version', value: { ...buildWardenSpawnProvenance(facts, preferred), v: 2 } },
    { label: 'a missing account', value: { ...buildWardenSpawnProvenance(facts, preferred), agent: undefined } },
    {
      label: 'an unknown model source',
      value: { ...buildWardenSpawnProvenance(facts, preferred), modelSource: 'vibes' },
    },
    { label: 'an unknown harness', value: { ...buildWardenSpawnProvenance(facts, preferred), harness: 'gpt' } },
    { label: 'an unknown policy', value: { ...buildWardenSpawnProvenance(facts, preferred), policy: 'random' } },
    { label: 'an unknown selection', value: { ...buildWardenSpawnProvenance(facts, preferred), selection: 'vibes' } },
    {
      label: 'a non-string skip reason',
      value: { ...buildWardenSpawnProvenance(facts, preferred), skipped: { 'primary-account': 3 } },
    },
    {
      label: 'a failover flag that contradicts the evidence',
      value: { ...buildWardenSpawnProvenance(facts, preferred), failedOver: true },
    },
  ])('should reject $label', ({ value }) => {
    // Arrange / Act
    const parsed = parseWardenSpawnProvenance(value);

    // Assert
    should(parsed).be.undefined();
  });
});

describe('warden provenance markdown', () => {
  it('should render the account, model and harness of a preferred launch', () => {
    // Arrange / Act
    const markdown = renderProvenanceMarkdown(buildWardenSpawnProvenance(facts, preferred));

    // Assert
    should(markdown).containEql('- Account: **`reserve-account`**');
    should(markdown).containEql('- Model: **`sample-model-2`**');
    should(markdown).containEql('- Model source: **Harness observation**');
    should(markdown).containEql('- Failover: **No**');
    should(markdown).not.containEql('- From:');
  });

  it('should explain where a failover came from and why', () => {
    // Arrange / Act
    const markdown = renderProvenanceMarkdown(buildWardenSpawnProvenance(facts, failedOver));

    // Assert
    should(markdown).containEql('- Failover: **Yes**');
    should(markdown).containEql('- From: **`primary-account`**');
    should(markdown).containEql('- Why: **at its weekly limit**');
  });

  it('should say the reason is unavailable when the daemon recorded none', () => {
    // Arrange / Act
    const markdown = renderProvenanceMarkdown(buildWardenSpawnProvenance(facts, { ...failedOver, skipped: {} }));

    // Assert
    should(markdown).containEql('- Why: **daemon reason unavailable**');
  });

  it('should render an unknown model as a word rather than a code span', () => {
    // Arrange / Act
    const markdown = renderProvenanceMarkdown(
      buildWardenSpawnProvenance({ ...facts, model: 'default', modelSource: 'unknown' }, preferred),
    );

    // Assert
    should(markdown).containEql('- Model: **Unknown**');
    should(markdown).containEql('- Model source: **Unknown**');
  });

  it('should neutralise markup that would break the surrounding report', () => {
    // Arrange
    const provenance = buildWardenSpawnProvenance(
      { ...facts, agent: 'weird`name', model: 'a\n  b' },
      { ...failedOver, skipped: { 'primary-account': 'hit *every* limit' } },
    );

    // Act
    const markdown = renderProvenanceMarkdown(provenance);

    // Assert
    should(markdown).containEql("- Account: **`weird'name`**");
    should(markdown).containEql('- Model: **`a b`**');
    should(markdown).containEql('hit \\*every\\* limit');
  });

  it('should label an account-mapped model as such', () => {
    // Arrange / Act
    const markdown = renderProvenanceMarkdown(
      buildWardenSpawnProvenance({ ...facts, modelSource: 'agent' }, preferred),
    );

    // Assert
    should(markdown).containEql('- Model source: **Account mapping**');
  });

  it('should label a configured model as such', () => {
    // Arrange / Act
    const markdown = renderProvenanceMarkdown(
      buildWardenSpawnProvenance({ ...facts, modelSource: 'configured' }, preferred),
    );

    // Assert
    should(markdown).containEql('- Model source: **Configured model**');
  });
});
