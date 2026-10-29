import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerInstructionsCommands } from '../../../src/lib/instructions/commands';
import { instructionsReport, renderInstructionsReport } from '../../../src/lib/instructions/report';

const LAUNCHED = {
  FY_SESSION_ID: 'session-7',
  FY_SESSION_MODE: 'interactive',
  FY_HYPERMEDIA: '1',
  FY_PACK: '0',
};

describe('instructionsReport', () => {
  it('should read each section exactly as the wrapper does: on only when its variable is 1', () => {
    // Act
    const report = instructionsReport({ ...LAUNCHED, FY_LEARNING_PASSIVE: 'yes' });

    // Assert
    should(report).match({ known: true, inFerret: true, sessionId: 'session-7', mode: 'interactive' });
    should(report.sections.map(section => [section.id, section.on])).deepEqual([
      ['hypermedia', true],
      ['pack', false],
      ['agenda', false],
      ['lessons', false],
    ]);
    should(report.sections[0]?.turnOn).be.undefined();
    should(report.sections[1]?.turnOn).equal(
      'The owner turns it on in Ferretry: open this ferret › Actions › Pack mode. It takes effect when this ferret next restarts (Actions › Restart). Settings › Pack mode, the machine’s switch, must be on too.',
    );
    should(report.sections[2]?.turnOn).startWith(
      'The owner turns it on in Ferretry: open this ferret › Actions › Agenda mode.',
    );
    should(report.sections[3]?.turnOn).startWith(
      'The owner turns it on in Ferretry: open this ferret › Actions › Passive learning.',
    );
  });

  it('should report Agenda mode on only when FY_AGENDA is exactly 1', () => {
    // Act
    const on = instructionsReport({ ...LAUNCHED, FY_AGENDA: '1' });
    const yes = instructionsReport({ ...LAUNCHED, FY_AGENDA: 'yes' });

    // Assert
    should(on.sections.find(section => section.id === 'agenda')).match({ label: 'Agenda mode', on: true });
    should(on.sections.find(section => section.id === 'agenda')).not.have.property('turnOn');
    should(yes.sections.find(section => section.id === 'agenda')?.on).be.false();
  });

  it('should say so outside a ferret, and leave out a mode it does not recognise', () => {
    // Act
    const outside = instructionsReport({ FY_HYPERMEDIA: '1' });
    const blank = instructionsReport({ FY_SESSION_ID: '', FY_SESSION_MODE: 'weird' });
    const unnamed = instructionsReport({ FY_SESSION_ID: 'session-8', FY_SESSION_MODE: 'weird', FY_PACK: '1' });
    const unhanded = instructionsReport({ FY_SESSION_ID: 'session-9' });

    // Assert
    should(outside.inFerret).be.false();
    should(outside).not.have.property('sessionId');
    should(blank.inFerret).be.false();
    should(unnamed).not.have.property('mode');
    should(renderInstructionsReport(outside, 'zz')).startWith('This is not running inside a ferret');
    should(renderInstructionsReport(unnamed, 'zz')).startWith('Sections ferret session-8 launched with:');
    // A tools server Codex handed only its forwarded list cannot tell, and says so rather than "all off".
    should(unhanded.known).be.false();
    should(renderInstructionsReport(unhanded, 'zz')).equal(
      "This process was not handed ferret session-9's section switches (a Codex tools server is not). Run `zz instructions` in your own shell instead.",
    );
  });

  it('should list every section with what to do about each one that is off', () => {
    // Act
    const text = renderInstructionsReport(instructionsReport(LAUNCHED), 'zz');

    // Assert
    should(text.split('\n')).deepEqual([
      'Sections ferret session-7 launched with (interactive):',
      '  ✓ Hypermedia: on',
      `  ✗ Pack mode: off. ${instructionsReport(LAUNCHED).sections[1]?.turnOn ?? ''}`,
      `  ✗ Agenda mode: off. ${instructionsReport(LAUNCHED).sections[2]?.turnOn ?? ''}`,
      `  ✗ Lessons: off. ${instructionsReport(LAUNCHED).sections[3]?.turnOn ?? ''}`,
      'These are fixed for this run: a switch changed now is in the system prompt from the next launch.',
    ]);
  });
});

describe('fy instructions', () => {
  const run = async (...argv: string[]): Promise<string[]> => {
    const lines: string[] = [];
    const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerInstructionsCommands(program, LAUNCHED, { success: message => lines.push(message) }, 'zz');
    await program.parseAsync(['node', 'fy', 'instructions', ...argv]);
    return lines;
  };

  it('should print the report, or its JSON with --json', async () => {
    // Act
    const text = await run();
    const json = await run('--json');

    // Assert
    should(text[0]).startWith('Sections ferret session-7 launched with (interactive):');
    should(JSON.parse(json[0] ?? '{}')).deepEqual(instructionsReport(LAUNCHED));
  });
});
