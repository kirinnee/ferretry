import { describe, it } from 'bun:test';
import { AGENDA_INSTRUCTION, BOARD_INSTRUCTION } from '@ferretry/fleet';
import { AgendaStageSchema } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { agendaCandidates, renderCandidates } from '../../../src/lib/agenda/candidates';
import { AGENDA_BODY_RULE, AGENDA_OPEN_RULE, registerAgendaCommands } from '../../../src/lib/agenda/commands';
import { AgendaController } from '../../../src/lib/agenda/controller';
import { TASK_CREATE_RULE, umbrellaRefusal } from '../../../src/lib/board/umbrella';
import { agentItem, CapturingOutput, RecordingAgendaGateway, SESSION, snapshot } from './fixtures';

/**
 * TEACHING MATCHES THE SPEC (docs/agenda.md § One channel per topic; the owner's agenda redesign, !A304): every rule
 * a ferret must learn is said, in the spec's words, by the prompt it is launched with AND by the command it runs.
 * A rule reworded in one place and not the other fails here. The phrases are few on purpose: each is a rule.
 */
const SPEC_RULES: ReadonlyArray<{
  readonly rule: string;
  /** Where the rule is taught: the Agenda or Board prompt section, and the CLI's own guidance. */
  readonly prompt: 'agenda' | 'board';
  readonly cli: 'agenda add' | 'task create';
  readonly phrase: string;
}> = [
  {
    rule: 'one channel per topic',
    prompt: 'agenda',
    cli: 'agenda add',
    phrase: "one channel of the owner's attention",
  },
  {
    rule: 'the three-part test',
    prompt: 'agenda',
    cli: 'agenda add',
    phrase: 'same place, same context, same pace',
  },
  { rule: 'search, check, then open', prompt: 'agenda', cli: 'agenda add', phrase: 'search, check, then open' },
  { rule: 'dependent things share one', prompt: 'agenda', cli: 'agenda add', phrase: 'dependent things always share' },
  { rule: "the owner's reply rests an item", prompt: 'agenda', cli: 'agenda add', phrase: 'rests' },
  { rule: 'only the ferret marks it Done', prompt: 'agenda', cli: 'agenda add', phrase: 'only you mark it' },
  { rule: 'no umbrella cards', prompt: 'board', cli: 'task create', phrase: 'no umbrella' },
  { rule: 'add to a related card', prompt: 'board', cli: 'task create', phrase: 'related card' },
  { rule: 'a card never asks the owner', prompt: 'board', cli: 'task create', phrase: 'never ask' },
  { rule: "public cards are the owner's asks", prompt: 'board', cli: 'task create', phrase: "the owner's asks" },
  { rule: 'planning is a phase', prompt: 'board', cli: 'task create', phrase: 'planning is a phase' },
  { rule: 'the board reads as a sitrep', prompt: 'board', cli: 'task create', phrase: 'sitrep' },
  { rule: 'read the card whole before a patch', prompt: 'board', cli: 'task create', phrase: 'show <id> --yaml' },
];

/** Case and line breaks do not change a rule: the help wraps its lines, the prompt does not. */
const said = (text: string): string => text.toLowerCase().replace(/\s+/gu, ' ');

/** `fy agenda [verb] --help`, as a ferret reads it. */
async function agendaHelp(...verb: string[]): Promise<string> {
  let help = '';
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({
    writeOut: text => {
      help += text;
    },
    writeErr: () => {},
  });
  registerAgendaCommands(
    program,
    new AgendaController(new RecordingAgendaGateway(snapshot([])), new CapturingOutput(), SESSION),
  );
  await program.parseAsync(['node', 'fy', 'agenda', ...verb, '--help']).catch(() => undefined);
  return help;
}

const agendaAddHelp = (): Promise<string> => agendaHelp('add');

describe('the teaching matches the agenda-first spec', () => {
  for (const { rule, prompt, cli, phrase } of SPEC_RULES) {
    it(`should say "${rule}" in the ${prompt} prompt and in fy ${cli}`, async () => {
      // Arrange
      const taught = prompt === 'agenda' ? AGENDA_INSTRUCTION('fy') : BOARD_INSTRUCTION('fy');
      const guidance = cli === 'agenda add' ? await agendaAddHelp() : TASK_CREATE_RULE;

      // Assert
      should(said(taught)).containEql(phrase);
      should(said(guidance)).containEql(phrase);
    });
  }

  it('should put the open rule in fy agenda add --help before the kinds', async () => {
    // Act
    const help = await agendaAddHelp();

    // Assert
    should(help).containEql(AGENDA_OPEN_RULE);
    should(help.indexOf(AGENDA_OPEN_RULE)).be.below(help.indexOf('ONE ANSWER SHAPE PER KIND'));
  });

  it("should ask the spec's question in the add's own listing, and the umbrella refusal should name the way out", () => {
    // Act
    const listing = renderCandidates(
      agendaCandidates([agentItem('A3', 'pick a relay')], { sessionId: SESSION, title: 'Relay', ask: 'pick one' }),
      {
        binary: 'fy',
        request: {
          action: 'add',
          source: 'agent-raised',
          sourceRef: null,
          subject: 'pick one',
          why: 'pick one',
          howToResolve: 'answer',
        },
      },
    );

    // Assert
    should(said(listing)).containEql('search, check, then open');
    should(said(listing)).containEql('should this join !a3?');
    should(said(listing)).containEql('same place, same context, same pace');
    should(said(listing)).containEql('dependent things always share one');
    should(umbrellaRefusal(['x'], 'fy')).containEql('--broad "<why this must be one card>"');
  });
});

/** The verbs the spec's "Teaching ferrets" section names: each is taught in the prompt AND is a real command with help. */
const SPEC_VERBS: ReadonlyArray<{ readonly verb: string; readonly taught: string }> = [
  { verb: 'answer', taught: 'answer <id> "…"' },
  { verb: 'rest', taught: 'rest <id> --why' },
  { verb: 'log', taught: 'log <id> --reply|--rest' },
  { verb: 'split', taught: '`split`' },
  { verb: 'merge', taught: '`merge`' },
  { verb: 'patch', taught: '→`patch <id> --file f`' },
  { verb: 'done', taught: 'mark it `done`' },
];

describe('the teaching names every agenda verb the spec lists', () => {
  const program = new Command().name('fy').exitOverride();
  registerAgendaCommands(
    program,
    new AgendaController(new RecordingAgendaGateway(snapshot([])), new CapturingOutput(), SESSION),
  );
  const agenda = program.commands.find(command => command.name() === 'agenda');

  for (const { verb, taught } of SPEC_VERBS) {
    it(`should teach "${verb}" in the agenda prompt and register fy agenda ${verb} with a description`, () => {
      // Act
      const command = agenda?.commands.find(each => each.name() === verb);

      // Assert
      should(said(AGENDA_INSTRUCTION('fy'))).containEql(said(taught));
      should(command).not.be.undefined();
      should(command?.description().length).be.above(0);
    });
  }

  it("should teach no item type: the stage chain stays the daemon's and --stage's help, never the prompt's", () => {
    // Arrange — the owner (&C48): "now agenda doesn't have a "main" type any more"; the tabs hold any kind.
    const stages = AgendaStageSchema.options.filter(stage => stage !== 'done');
    const prompt = AGENDA_INSTRUCTION('fy');

    // Assert
    should(prompt).not.containEql(stages.join('→'));
    should(prompt).not.containEql('`--stage`');
    should(prompt).containEql('whole→`patch');
  });

  it('should say a resting item is quiet, a Needs-you item buzzes, and rest --why means working', () => {
    // Act
    const prompt = said(AGENDA_INSTRUCTION('fy'));

    // Assert
    should(prompt).containEql('needs you buzzes; resting is quiet');
    should(prompt).containEql('rest <id> --why …`=working');
  });

  it('should answer an owner question ON its item, and open one info item only when no item exists', () => {
    // Assert
    should(said(AGENDA_INSTRUCTION('fy'))).containEql('no item: one `-k info`');
  });
});

/**
 * THE TABS ARE THE LIVE DOCUMENT (docs/agenda.md § The tabs, &F923; the owner on !A332: "the chat is the stream of log,
 * the body is the DB"): the main tab, "Where we are now", opens first and is as long as it needs to be; the full picture
 * and the ferret's own tabs sit beside it; each is rewritten whole on every change, and the conversation only points at
 * them. The prompt says it in short; every help says it whole.
 */
describe('the teaching says the tabs are the live document and the chat is its log', () => {
  it('should say it in the agenda prompt: the tabs, each rewritten whole, the chat pointing at them', () => {
    // Act
    const prompt = said(AGENDA_INSTRUCTION('fy'));

    // Assert
    should(prompt).containEql(
      "ask/answer stack on the topic's one item: `show <id> --yaml` whole→`patch <id> --file f`",
    );
    // The owner on !A404: every unresolved ask stays floated; answered Q&A moves to a History tab.
    should(prompt).containEql('float every open ask in premise (where we are) + ask (what i need)');
    should(prompt).containEql('answered q&a→`history`, oldest first, with answer');
    should(prompt).containEql('tabs by kind, serial stays one; steps/explainers stay.');
    should(prompt).containEql('chat points there');
    should(prompt).not.containEql('short status');
    should(prompt).not.containEql('one-screen summary');
  });

  it('should say the whole rule in fy agenda --help, add --help and edit --help', async () => {
    // Act
    const helps = await Promise.all([agendaHelp(), agendaHelp('add'), agendaHelp('edit')]);

    // Assert
    for (const help of helps) should(said(help)).containEql(said(AGENDA_BODY_RULE));
  });

  it('should name each part of the rule: the main tab, the tabs, the rewrite, the log, explainer mode, hypermedia and folds', () => {
    // Act
    const rule = said(AGENDA_BODY_RULE);

    // Assert
    should(rule).containEql('the tabs are the live document; the conversation is only the log');
    // The owner (&C48): every update rewrites the ask, still-open and the tabs; tabs hold any kind; no main type.
    // And READ → EDIT (the owner: "we need to read to know what needs to be updated, else there might be many segments
    // that might be outdated!"), every part of it (!A358): premise, context, the ask, its options and how to reply, tabs.
    should(rule).containEql(
      'always keep the item current: before every update read it whole (agenda show <id> --yaml)',
    );
    should(rule).containEql('write it back in one go: agenda patch <id> --file f.yaml');
    // The owner on !A404: asks and answers stack on one item; an open ask is never dropped; answered Q&A is History.
    should(rule).containEql(
      'every ask and answer on a topic stacks on the same item, and an open ask is never dropped',
    );
    should(rule).containEql(
      'every unresolved ask stays floated in "where we are" (premise, context) and in "what i need from you"',
    );
    should(rule).containEql(
      'an answered question moves to a "history" tab, oldest first, each marked answered with its answer',
    );
    should(rule).containEql('open a new item only for a clearly separate topic');
    should(rule).containEql(
      'premise, context, the ask (what you need from the owner), its options and how to reply, still-open and each tab',
    );
    should(rule).containEql('tabs hold any kind of content');
    should(rule).containEql('there is no main type: "where we are now" (--where-file, or --where points)');
    should(rule).containEql('is simply the tab that opens first');
    should(rule).containEql('as long and as rich as it needs to be');
    should(rule).containEql('"the full picture" (--body-file)');
    should(rule).containEql('--tab-file "name=file" (6 at most)');
    should(rule).containEql('--rename-tab, --move-tab, --remove-tab');
    should(rule).not.containEql('short status');
    // The owner's split rule (&F946): by content type, never serial content; a continuous report stays one tab.
    should(rule).containEql('split the rest by content type, never serial content');
    should(rule).containEql('named for what it holds');
    should(rule).containEql('where each part builds on the last, stays one tab');
    should(rule).containEql('one kind of content is one tab: never invent tabs');
    should(rule).containEql('the body may stay empty');
    // The owner (&C48): "make sure that steps and explainers go the body tabs and kept there!"
    should(rule).containEql('steps and explainers live in the tabs and stay there, after the ask is answered too');
    should(rule).containEql("a to-do's --step boxes are only what the owner ticks off");
    should(rule).containEql('rewrite a tab whole whenever it changes: one edit is one version');
    should(rule).containEql('never retype a tab into the conversation');
    should(rule).containEql('explainer mode, adhd-friendly');
    should(rule).containEql('card and board blocks');
    // The body's Markdown draws no fold of its own: a fold is an fy-render html block's <details>.
    should(rule).containEql('plain markdown draws no fold');
  });
});
