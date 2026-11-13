import { describe, it } from 'bun:test';
import { type AgendaItem, AgendaEditRequestSchema, agendaItemRevision } from '@ferretry/core-asks/contract';
import should from 'should';
import { AgendaController } from '../../../cli/lib/controller.ts';
import { agendaPatchDocument, composeAgendaPatch, parseAgendaPatch } from '../../../cli/lib/patch.ts';
import { documentYaml } from '@ferretry/std/yaml';
import { agentItem, CapturingOutput, RecordingAgendaGateway, SESSION, snapshot } from './fixtures.ts';

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const neededBy = (typed: string): string => (typed === 'in 3h' ? '2026-11-04T15:00:00.000Z' : typed);

const item: AgendaItem = agentItem('A5', 'Use the proposed wording?', {
  title: 'Teaching wording',
  premise: '- The prompt lines only hint at the rules',
  context: '- Three rules are affected',
  decided: '- Tabs by name',
  whereWeAre: 'Drafted the wording.',
  body: 'The full report.',
  tabs: [
    { id: 'status', name: 'Status', body: '- Now: drafting' },
    { id: 'risks', name: 'Risks', body: '- None yet' },
  ],
  kind: 'yesno',
});

const parsed = (text: string) => {
  const result = parseAgendaPatch(text, 'a5.yaml');
  if (!result.ok) throw new Error(result.problems.join('\n'));
  return result.patch;
};

describe('agenda show --yaml', () => {
  it('should print the revision first and every field a ferret may change, tabs by name', () => {
    // Act
    const document = agendaPatchDocument(item);

    // Assert
    should(Object.keys(document)[0]).equal('revision');
    should(document.revision).equal(agendaItemRevision(item));
    should(document).containDeep({
      title: 'Teaching wording',
      summary: 'Use the proposed wording?',
      why: 'nothing else can proceed',
      howToResolve: 'answer on the board',
      tabs: { Status: '- Now: drafting', Risks: '- None yet' },
      kind: 'yesno',
    });
    should(document).not.have.property('raisedBy');
    should(document).not.have.property('waitingSince');
  });

  it('should round-trip: the printed YAML patched back changes nothing', () => {
    // Arrange
    const yaml = documentYaml(agendaPatchDocument(item), ['a comment']);

    // Act
    const plan = composeAgendaPatch(item, parsed(yaml), neededBy);

    // Assert
    should(yaml.startsWith('# a comment\nrevision: ')).be.true();
    should(plan).deepEqual({ kind: 'unchanged' });
  });
});

describe('agenda patch', () => {
  const revision = agendaItemRevision(item);

  it('should send ONE edit with only what differs: fields, clears and tab operations by name', () => {
    // Arrange
    const patch = parsed(
      [
        `revision: ${revision}`,
        'summary: Ship the wording this week?',
        'why: The wording is ready; shipping it needs your yes.',
        'title: Teaching wording',
        'decided: null',
        'neededBy: in 3h',
        'tabs:',
        '  Status: |',
        '    - Now: waiting for the merge',
        '  Risks: null',
        '  Steps: "1. Merge"',
        '  Gone: null',
      ].join('\n'),
    );

    // Act
    const plan = composeAgendaPatch(item, patch, neededBy);

    // Assert
    should(plan).deepEqual({
      kind: 'edit',
      request: {
        action: 'edit',
        id: 'A5',
        revision,
        subject: 'Ship the wording this week?',
        why: 'The wording is ready; shipping it needs your yes.',
        neededBy: '2026-11-04T15:00:00.000Z',
        clear: ['decided'],
        tabEdits: [
          { tab: 'Status', body: '- Now: waiting for the merge' },
          { tab: 'Risks', remove: true },
          { tab: 'Steps', body: '1. Merge' },
        ],
      },
    });
  });

  it('should never send an unchanged kind, so a round-trip never re-asks the owner', () => {
    // Act
    const plan = composeAgendaPatch(
      item,
      parsed(`revision: ${revision}\nkind: yesno\nbody: The full report.`),
      neededBy,
    );

    // Assert
    should(plan).deepEqual({ kind: 'unchanged' });
  });

  it('should refuse a patch written against an older revision', () => {
    // Act
    const plan = composeAgendaPatch(item, parsed('revision: abc123\nsummary: Something new?'), neededBy);

    // Assert
    should(plan).deepEqual({ kind: 'stale' });
  });

  it('should require the revision, so the item is always read before it is written', () => {
    // Act
    const result = parseAgendaPatch('summary: Something new?', 'a5.yaml');

    // Assert
    should(result.ok).be.false();
    should(!result.ok && result.problems[0]).match(/^revision: required — read the whole item first/u);
  });

  it('should refuse unknown and read-only keys by name, and a null that would drop what a cold reader needs', () => {
    // Act
    const result = parseAgendaPatch(
      `revision: ${revision}\nsumary: typo\nraisedBy: agent\npremise: null\ntabs:\n  Status: ""`,
      'a5.yaml',
    );

    // Assert
    should(result.ok).be.false();
    const problems = result.ok ? [] : result.problems.join('\n');
    should(problems).match(/sumary: not a field a patch changes \(it takes: revision, title, summary/u);
    should(problems).match(/raisedBy: not a field a patch changes/u);
    should(problems).match(/premise: /u);
    should(problems).match(/tabs\.Status: /u);
  });

  it('should take JSON as well as YAML, and say plainly when the text is neither', () => {
    // Act
    const json = parseAgendaPatch(`{"revision": "${revision}", "urgency": "before Friday"}`, 'a5.json');
    const broken = parseAgendaPatch('summary: [unclosed', 'a5.yaml');
    const list = parseAgendaPatch('- one\n- two', 'a5.yaml');

    // Assert
    should(json.ok).be.true();
    should(!broken.ok && broken.problems[0]).match(/^a5\.yaml cannot be read:/u);
    should(!list.ok && list.problems[0]).match(/must be a mapping/u);
  });
});

describe('agenda patch command', () => {
  const build = (files: Record<string, string>) => {
    const board = snapshot([item]);
    const gateway = new RecordingAgendaGateway(board, board);
    const out = new CapturingOutput();
    const input = { read: async (path: string) => files[path] ?? '' };
    return { gateway, out, controller: new AgendaController(gateway, out, SESSION, input, () => NOW) };
  };

  it('should apply one edit carrying the revision, read from stdin by default', async () => {
    // Arrange
    const { gateway, controller } = build({ '-': `revision: ${agendaItemRevision(item)}\nurgency: before Friday` });

    // Act
    await controller.patch('!A5', {});

    // Assert
    should(gateway.applied).deepEqual([
      {
        sessionId: SESSION,
        request: { action: 'edit', id: 'A5', revision: agendaItemRevision(item), urgency: 'before Friday' },
      },
    ]);
  });

  it('should send nothing and say so when nothing changed', async () => {
    // Arrange
    const { gateway, out, controller } = build({ 'a5.yaml': documentYaml(agendaPatchDocument(item), []) });

    // Act
    await controller.patch('A5', { file: 'a5.yaml' });

    // Assert
    should(gateway.applied).be.empty();
    should(out.messages[0]).match(/nothing changed, so nothing was sent/u);
  });

  it('should refuse a stale patch with the way to read it again, and send nothing', async () => {
    // Arrange
    const { gateway, controller } = build({ '-': 'revision: old\nurgency: before Friday' });

    // Act + Assert
    await should(controller.patch('A5', {})).be.rejectedWith(/changed since you read it.*agenda show A5 --yaml/u);
    should(gateway.applied).be.empty();
  });

  it('should refuse a document that names no field to change', () => {
    // Act
    const empty = parseAgendaPatch(`revision: ${agendaItemRevision(item)}`, 'a5.yaml');

    // Assert
    should(empty.ok).be.false();
    should(!empty.ok && empty.problems).deepEqual(['a5.yaml names no field to change: a patch changes at least one']);
  });

  it('should say every problem of a bad document at once and send nothing', async () => {
    // Arrange
    const { gateway, controller } = build({ '-': `revision: ${agendaItemRevision(item)}\nbogus: 1` });

    // Act + Assert
    await should(controller.patch('A5', {})).be.rejectedWith(
      /agenda patch A5 changed nothing:\n {2}bogus: not a field/u,
    );
    should(gateway.applied).be.empty();
  });

  it('should print the editable document with show --yaml', async () => {
    // Arrange
    const { out, controller } = build({});

    // Act
    await controller.show('A5', { yaml: true });

    // Assert
    should(out.messages[0]).match(
      /^# !A5 — read every part, update what is out of date, then: fy agenda patch A5 --file <this file>/u,
    );
    should(out.messages[0]).match(/\nrevision: \S+\ntitle: Teaching wording\n/u);
    should(out.messages[0]).match(/\ntabs:\n {2}Status: "- Now: drafting"\n/u);
  });
});

describe('a long why', () => {
  it('should round-trip: a 1,500-character why written back changes nothing', () => {
    // Arrange
    const long: AgendaItem = { ...item, why: `${'word '.repeat(299)}end..` };
    const yaml = documentYaml(agendaPatchDocument(long), []);

    // Act
    const plan = composeAgendaPatch(long, parsed(yaml), neededBy);

    // Assert
    should(long.why).have.length(1_500);
    should(plan).deepEqual({ kind: 'unchanged' });
  });

  it('should compose an edit whose why the edit request accepts', () => {
    // Arrange
    const why = 'x'.repeat(1_500);
    const patch = parsed(`revision: ${agendaItemRevision(item)}\nwhy: ${why}\n`);

    // Act
    const plan = composeAgendaPatch(item, patch, neededBy);

    // Assert
    if (plan.kind !== 'edit') throw new Error(`expected an edit, got ${plan.kind}`);
    should(AgendaEditRequestSchema.safeParse(plan.request).success).be.true();
  });
});
