import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerNotifyCommands } from '../../../src/lib/notify/commands';
import { CapturingOutput, ports, RecordingNotifyGateway, SESSION } from './fixtures';

function run(argv: string[], gateway = new RecordingNotifyGateway(), own: string | null = SESSION) {
  const out = new CapturingOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerNotifyCommands(program, ports(gateway, out, own ?? undefined));
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, out };
}

describe('fy notify', () => {
  it('should raise one notice on the caller’s own session and say where the owner sees it', async () => {
    // Arrange + Act
    const { parsed, gateway, out } = run(['notify', 'The', 'build', 'is', 'green']);
    await parsed;

    // Assert
    should(gateway.raised).have.length(1);
    should(gateway.raised[0]?.sessionId).equal(SESSION);
    should(gateway.raised[0]?.request.subject).equal('The build is green');
    should(gateway.raised[0]?.request).not.have.property('ping');
    should(out.messages).deepEqual(["Sent. The owner sees it in this ferret's Inbox."]);
  });

  it('should pass --body through and say the phone buzzes when --ping is given', async () => {
    // Arrange + Act
    const { parsed, gateway, out } = run(['notify', 'Prod is down', '--body', '## Why\n\nThe disk is full', '--ping']);
    await parsed;

    // Assert
    should(gateway.raised[0]?.request.body).equal('## Why\n\nThe disk is full');
    should(gateway.raised[0]?.request.ping).equal(true);
    should(out.messages[0]).equal("Sent. The owner sees it in this ferret's Inbox and their phone buzzes.");
  });

  it('should target --session over its own session', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['notify', 'hello', '--session', 'other-1']);
    await parsed;

    // Assert
    should(gateway.raised[0]?.sessionId).equal('other-1');
  });

  it('should raise nothing without a summary', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['notify']);

    // Assert
    await should(parsed).be.rejectedWith(/needs a summary/u);
    should(gateway.raised).be.empty();
  });

  it('should say there is no session when run outside one', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['notify', 'hello'], new RecordingNotifyGateway(), null);

    // Assert
    await should(parsed).be.rejectedWith(/no session id — run inside a session or pass --session <id>/u);
    should(gateway.raised).be.empty();
  });

  it('should pass the daemon’s refusal through in its own words and print no success', async () => {
    // Arrange
    const refused = new RecordingNotifyGateway(false, new Error('an agent may notify only for its own session'));

    // Act
    const { parsed, out } = run(['notify', 'hello'], refused);

    // Assert
    await should(parsed).be.rejectedWith('an agent may notify only for its own session');
    should(out.messages).be.empty();
  });
});

describe('fy notify agenda', () => {
  it('should read the switch without changing it', async () => {
    // Arrange + Act
    const { parsed, gateway, out } = run(['notify', 'agenda']);
    await parsed;

    // Assert
    should(gateway.read).deepEqual([SESSION]);
    should(gateway.switched).be.empty();
    should(out.messages).deepEqual(['Agenda mode is off. It keeps no agenda from its next launch.']);
  });

  it('should switch it on and off and print what the daemon says that does', async () => {
    // Arrange
    const gateway = new RecordingNotifyGateway();

    // Act
    const on = run(['notify', 'agenda', 'on'], gateway);
    await on.parsed;
    const off = run(['notify', 'agenda', 'OFF'], gateway);
    await off.parsed;

    // Assert
    should(gateway.switched).deepEqual([
      { sessionId: SESSION, enabled: true },
      { sessionId: SESSION, enabled: false },
    ]);
    should(on.out.messages).deepEqual(['Agenda mode is now on. It is told to keep an agenda at its next launch.']);
    should(off.out.messages[0]).startWith('Agenda mode is now off.');
  });

  it('should honour --session on the subcommand, and refuse a state that is not on or off', async () => {
    // Arrange
    const gateway = new RecordingNotifyGateway();

    // Act
    const targeted = run(['notify', 'agenda', 'on', '--session', 'other-1'], gateway);
    await targeted.parsed;
    const bad = run(['notify', 'agenda', 'maybe'], gateway);

    // Assert
    should(gateway.switched).deepEqual([{ sessionId: 'other-1', enabled: true }]);
    await should(bad.parsed).be.rejectedWith(/"on" or "off", not "maybe"/u);
  });

  it('should say there is no session when run outside one', async () => {
    // Arrange + Act
    const { parsed } = run(['notify', 'agenda'], new RecordingNotifyGateway(), null);

    // Assert
    await should(parsed).be.rejectedWith(/no session id/u);
  });
});
