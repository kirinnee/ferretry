import { describe, it } from 'bun:test';
import should from 'should';
import * as discovery from '../../src/lib/harness-discovery.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

/**
 * The contract a browser fills a form in from.
 *
 * The interesting assertions are the REFUSALS. This shape exists so a prefilled field can always be
 * traced, and every rejection below is a way of shipping a value nobody could trace: a model list with
 * no default, a default that is not in the list, a detection with no source, an absence with no reason.
 */

const installed: discovery.HarnessDiscovery = {
  kind: 'claude',
  command: '/usr/local/bin/claude',
  absenceImpact: 'No Claude session could start on this host.',
  models: {
    origin: 'detected',
    ids: ['claude-opus-5'],
    defaultModel: 'claude-opus-5',
    source: '/home/pilot/.claude/settings.json',
  },
  instructions: { found: true, source: '/home/pilot/.claude/CLAUDE.md', text: '# Rules\n', bytes: 8 },
};

const absent: discovery.HarnessDiscovery = {
  kind: 'codex',
  absenceImpact: 'No Codex session could start on this host.',
  models: {
    origin: 'fallback',
    ids: ['gpt-5.6'],
    defaultModel: 'gpt-5.6',
    source: 'Ferretry’s starter model for codex, because there is no /home/pilot/.codex/config.toml on this host',
  },
  instructions: { found: false, source: '/home/pilot/.codex/AGENTS.md', reason: 'this host has no AGENTS.md there' },
};

const report: discovery.HarnessDiscoveryReport = {
  harnesses: [installed, absent],
  noneInstalled: false,
  limitation: 'A PATH lookup proves nothing about being signed in.',
};

const cases: SchemaCase[] = [
  { name: 'origin', schema: discovery.HarnessModelOriginSchema, value: 'fallback' },
  { name: 'models', schema: discovery.HarnessModelsSchema, value: installed.models },
  { name: 'instructions', schema: discovery.HarnessInstructionsSchema, value: installed.instructions },
  { name: 'harness', schema: discovery.HarnessDiscoverySchema, value: installed },
  { name: 'report', schema: discovery.HarnessDiscoveryReportSchema, value: report },
];

describe('harness discovery contract', () => {
  it('should round-trip every schema this module publishes', () => {
    // Act + Assert — the coverage assertion is the point: the day a field is added here, this test fails
    // until somebody has decided what the new shape MEANS to a reader.
    assertRoundTrips(cases);
    assertCoversEverySchema(discovery, cases);
  });

  it('should carry an installed harness with its resolved path and an absent one with none', () => {
    // Act
    const parsed = discovery.HarnessDiscoveryReportSchema.parse(report);

    // Assert — `command` absent is how "not installed" is said. An empty string would be a path.
    should(parsed.harnesses[0]?.command).equal('/usr/local/bin/claude');
    should(parsed.harnesses[1]).not.have.property('command');
  });

  it('should refuse a model report a form could not act on', () => {
    // Arrange — each of these is a shape that renders as a filled-in box with nothing behind it.
    assertRejects([
      { name: 'no models at all', schema: discovery.HarnessModelsSchema, value: { ...installed.models, ids: [] } },
      {
        name: 'a detection with no source',
        schema: discovery.HarnessModelsSchema,
        value: { origin: 'detected', ids: ['x'], defaultModel: 'x', source: '' },
      },
      {
        name: 'an origin nobody has decided how to render',
        schema: discovery.HarnessModelsSchema,
        value: { ...installed.models, origin: 'guessed' },
      },
      {
        name: 'an empty model identifier',
        schema: discovery.HarnessModelsSchema,
        value: { ...installed.models, ids: [''] },
      },
    ]);
  });

  it('should refuse an instructions answer that states neither text nor a reason', () => {
    // Arrange — "not found" with no reason and no path is the blank this contract exists to prevent:
    // "we did not look" and "there is nothing there" send a reader to two different places.
    assertRejects([
      {
        name: 'found with no source',
        schema: discovery.HarnessInstructionsSchema,
        value: { found: true, source: '', text: '', bytes: 0 },
      },
      {
        name: 'absent with no reason',
        schema: discovery.HarnessInstructionsSchema,
        value: { found: false, source: '/x/CLAUDE.md' },
      },
      {
        name: 'found without its text',
        schema: discovery.HarnessInstructionsSchema,
        value: { found: true, source: '/x/CLAUDE.md', bytes: 3 },
      },
      {
        name: 'a negative byte count',
        schema: discovery.HarnessInstructionsSchema,
        value: { found: true, source: '/x/CLAUDE.md', text: 'abc', bytes: -1 },
      },
    ]);
    // An EMPTY document is a real state and must survive: somebody's CLAUDE.md can be a blank file.
    should(
      discovery.HarnessInstructionsSchema.parse({ found: true, source: '/x/CLAUDE.md', text: '', bytes: 0 }),
    ).have.property('found', true);
  });

  it('should refuse a report that names no harness or hides what an absence breaks', () => {
    // Arrange — a report listing only what it found could not answer "is Codex set up here?", and a
    // harness with no stated impact is a diagnosis with no consequence attached.
    assertRejects([
      { name: 'no harnesses', schema: discovery.HarnessDiscoveryReportSchema, value: { ...report, harnesses: [] } },
      { name: 'no limitation', schema: discovery.HarnessDiscoveryReportSchema, value: { ...report, limitation: '' } },
      {
        name: 'no absence impact',
        schema: discovery.HarnessDiscoverySchema,
        value: { ...installed, absenceImpact: '' },
      },
      {
        name: 'an unknown harness kind',
        schema: discovery.HarnessDiscoverySchema,
        value: { ...installed, kind: 'gpt' },
      },
      {
        name: 'a field nobody declared',
        schema: discovery.HarnessDiscoverySchema,
        value: { ...installed, signedIn: true },
      },
    ]);
  });
});
