import { describe, it } from 'bun:test';
import { type AgendaItem, agendaItemRevision, DAEMON_FEATURES } from '@ferretry/protocol';
import should from 'should';
import { AgendaController } from '../../../src/lib/agenda/controller';
import { agendaPatchDocument, composeAgendaPatch, parseAgendaPatch } from '../../../src/lib/agenda/patch';
import { patchYaml } from '../../../src/lib/patch/document';
import { agentItem, CapturingOutput, RecordingAgendaGateway, SESSION, snapshot } from './fixtures';

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
    const yaml = patchYaml(agendaPatchDocument(item), ['a comment']);

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
    should(!broken.ok && broken.problems[0]).match(/^a5\.yaml is not YAML or JSON/u);
    should(!list.ok && list.problems[0]).match(/must be a mapping/u);
  });
});

describe('agenda patch command', () => {
  const build = (files: Record<string, string>, offered: readonly string[] = [DAEMON_FEATURES.agendaPatch]) => {
    const board = snapshot([item]);
    const gateway = new RecordingAgendaGateway(board, board);
    gateway.offered = offered;
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
    const { gateway, out, controller } = build({ 'a5.yaml': patchYaml(agendaPatchDocument(item), []) });

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

  it('should name an older daemon before anything is sent', async () => {
    // Arrange
    const { gateway, controller } = build({ '-': `revision: ${agendaItemRevision(item)}\nurgency: x` }, []);

    // Act + Assert
    await should(controller.patch('A5', {})).be.rejectedWith(/older than agenda patch/u);
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
