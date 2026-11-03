import { describe, it } from 'bun:test';
import { AGENDA_INSTRUCTION, BOARD_INSTRUCTION } from '@ferretry/fleet';
import { Command } from 'commander';
import should from 'should';
import { agendaCandidates, renderCandidates } from '../../../src/lib/agenda/candidates';
import { AGENDA_OPEN_RULE, registerAgendaCommands } from '../../../src/lib/agenda/commands';
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
  { rule: 'only the ferret marks it Done', prompt: 'agenda', cli: 'agenda add', phrase: 'only you mark it done' },
  { rule: 'no umbrella cards', prompt: 'board', cli: 'task create', phrase: 'no umbrella' },
  { rule: 'check related cards first', prompt: 'board', cli: 'task create', phrase: 'check related cards first' },
  { rule: 'a card shows progress only', prompt: 'board', cli: 'task create', phrase: 'progress only' },
];

/** Case and line breaks do not change a rule: the help wraps its lines, the prompt does not. */
const said = (text: string): string => text.toLowerCase().replace(/\s+/gu, ' ');

async function agendaAddHelp(): Promise<string> {
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
  await program.parseAsync(['node', 'fy', 'agenda', 'add', '--help']).catch(() => undefined);
  return help;
}

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
