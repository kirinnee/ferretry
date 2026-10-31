import { describe, it } from 'bun:test';
import { unpadInputValue } from '@ferretry/protocol';
import should from 'should';
import { FERRET_REFUSAL, InputController } from '../../../src/lib/input/controller';
import {
  DELIVERY,
  DIGEST,
  FakeHiddenPrompt,
  FakeInputGateway,
  REQUEST_ID,
  request,
  rig,
  SESSION,
  VALUE,
} from './fixtures';

const options = { session: SESSION };

describe('fy input answer', () => {
  it('should read the value hidden, pad it, and send it once with the digest the card showed', async () => {
    // Arrange
    const { ports, gateway, out, prompt } = rig();

    // Act
    await new InputController(ports).answer('!A7', options);

    // Assert
    should(prompt.asked).have.length(1);
    should(gateway.delivered).have.length(1);
    const sent = gateway.delivered[0];
    should(sent?.sessionId).equal(SESSION);
    should(sent?.requestId).equal(REQUEST_ID);
    should(sent?.body.deliveryId).equal(DELIVERY);
    should(sent?.body.observedDigest).equal(DIGEST);
    should(sent?.body.submit).equal(true);
    should(unpadInputValue(sent?.body.padded ?? '')).equal(VALUE);
    should(sent?.body.padded).not.equal(VALUE);
    should(out.messages).deepEqual(['Sent to %terminal:dev and pressed Enter.']);
  });

  it('should show the owner what the daemon saw, in the daemon’s words rather than the agent’s', async () => {
    // Arrange
    const { ports, out } = rig();

    // Act
    await new InputController(ports).answer('A7', options);

    // Assert
    const shown = out.diagnostics.join('\n');
    should(shown).containEql('the agent says: sudo password to install the package');
    should(shown).containEql('reading the terminal now: sudo');
    should(shown).containEql('echo: off');
    should(shown).containEql('[sudo] password for deploy:');
  });

  it('should never put the value in anything it prints or sends outside the padded field', async () => {
    // Arrange
    const { ports, gateway, out } = rig();

    // Act
    await new InputController(ports).answer('!A7', { ...options, json: true });

    // Assert
    should(out.all()).not.containEql(VALUE);
    const { padded, ...rest } = gateway.delivered[0]?.body ?? { padded: '' };
    should(JSON.stringify(rest)).not.containEql(VALUE);
    should(padded).be.a.String();
  });

  it('should not leak the value into the error it throws when the daemon refuses', async () => {
    // Arrange
    const gateway = new FakeInputGateway([request()], { state: 'refused', submitted: false, reason: 'target_changed' });
    const { ports, out } = rig({}, gateway);

    // Act
    await new InputController(ports).answer('!A7', options);

    // Assert
    should(out.messages).deepEqual(['Not sent: the target is no longer the one the card showed.']);
    should(out.all()).not.containEql(VALUE);
  });

  it('should refuse inside a ferret’s pane before it reads or sends anything', async () => {
    // Arrange
    const { ports, gateway, prompt } = rig({ ownSessionId: 'mvgt2oz9-04e28935' });

    // Act
    const failure = await new InputController(ports).answer('!A7', options).catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).equal(FERRET_REFUSAL);
    should(prompt.asked).have.length(0);
    should(gateway.listed).have.length(0);
    should(gateway.delivered).have.length(0);
  });

  it('should refuse with an agent credential in the environment, for every verb', async () => {
    // Arrange
    const { ports, gateway } = rig({ agentCredential: 'capability-token' });
    const controller = new InputController(ports);

    // Act
    const failures = await Promise.all([
      controller.list(options).catch((error: unknown) => error),
      controller.answer('!A7', options).catch((error: unknown) => error),
      controller.cancel('!A7', options).catch((error: unknown) => error),
    ]);

    // Assert
    for (const failure of failures) should((failure as Error).message).equal(FERRET_REFUSAL);
    should(gateway.listed).have.length(0);
    should(gateway.cancelled).have.length(0);
  });

  it('should refuse off a terminal, because there is no pipe that carries a value', async () => {
    // Arrange
    const { ports, prompt, gateway } = rig({ interactive: false });

    // Act
    const failure = await new InputController(ports).answer('!A7', options).catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).containEql('needs a terminal you are sitting at');
    should(prompt.asked).have.length(0);
    should(gateway.delivered).have.length(0);
  });

  it('should refuse a value that would press keys, and send nothing', async () => {
    // Arrange
    const { ports, gateway } = rig({}, undefined, new FakeHiddenPrompt('abc\u0003def'));

    // Act
    const failure = await new InputController(ports).answer('!A7', options).catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).containEql('would press keys');
    should(gateway.delivered).have.length(0);
  });

  it('should show the risk flag and still type into an unfamiliar program, with no extra flag', async () => {
    // Arrange
    const base = request();
    const unfamiliar = request({
      observed: {
        ...(base.observed as NonNullable<typeof base.observed> & { kind: 'terminal' }),
        foreground: { pid: 9, pgid: 9, comm: 'python3', argv: 'python3 app.py' },
        recognisedConsumer: false,
      },
    });
    const flagged = {
      ...unfamiliar,
      risk: { level: 'amber', reason: 'The program is not one known to ask for secrets.' },
    } as typeof unfamiliar;
    const { ports, gateway, prompt, out } = rig({}, new FakeInputGateway([flagged]));

    // Act
    await new InputController(ports).answer('!A7', options);

    // Assert
    should(out.diagnostics.join('\n')).containEql('risk amber: The program is not one known to ask for secrets.');
    should(prompt.asked).have.length(1);
    should(gateway.delivered).have.length(1);
  });

  it('should leave Enter to the agent when it asked to press it, and honour --no-enter otherwise', async () => {
    // Arrange
    const agentEnters = rig({}, new FakeInputGateway([request({ submit: 'agent' })]));
    const owner = rig();

    // Act
    await new InputController(agentEnters.ports).answer('!A7', options);
    await new InputController(owner.ports).answer('!A7', { ...options, enter: false });

    // Assert
    should(agentEnters.gateway.delivered[0]?.body.submit).equal(false);
    should(owner.gateway.delivered[0]?.body.submit).equal(false);
  });

  it('should not press Enter in a browser field unless asked', async () => {
    // Arrange
    const browser = request({ target: { kind: 'browser', key: 'app' } });
    const first = rig({}, new FakeInputGateway([browser]));
    const second = rig({}, new FakeInputGateway([browser]));

    // Act
    await new InputController(first.ports).answer('!A7', options);
    await new InputController(second.ports).answer('!A7', { ...options, enter: true });

    // Assert
    should(first.gateway.delivered[0]?.body.submit).equal(false);
    should(second.gateway.delivered[0]?.body.submit).equal(true);
  });

  it('should wait while the daemon re-observes after a restart, and refuse one that is no longer pending', async () => {
    // Arrange
    const { observed: _observed, observedDigest: _digest, ...unobserved } = request();
    const waiting = rig({}, new FakeInputGateway([unobserved]));
    const done = rig({}, new FakeInputGateway([request({ state: 'delivered' })]));

    // Act
    const first = await new InputController(waiting.ports).answer('!A7', options).catch((error: unknown) => error);
    const second = await new InputController(done.ports).answer('!A7', options).catch((error: unknown) => error);

    // Assert
    should((first as Error).message).containEql('re-checked');
    should((second as Error).message).containEql('is delivered');
    should(waiting.prompt.asked).have.length(0);
    should(done.prompt.asked).have.length(0);
  });

  it('should need a session and a known card', async () => {
    // Arrange
    const { ports } = rig();
    const controller = new InputController(ports);

    // Act
    const noSession = await controller.answer('!A7', {}).catch((error: unknown) => error);
    const unknown = await controller.answer('!A9', options).catch((error: unknown) => error);
    const notAReference = await controller.answer('banana', options).catch((error: unknown) => error);

    // Assert
    should((noSession as Error).message).containEql('--session');
    should((unknown as Error).message).containEql('no input request !A9');
    should((notAReference as Error).message).containEql('not an agenda reference');
  });
});

describe('fy input ls and cancel', () => {
  it('should list each request with what it is typed into, and no value', async () => {
    // Arrange
    const { ports, out } = rig();

    // Act
    await new InputController(ports).list(options);

    // Assert
    should(out.messages[0]).containEql('!A7  pending  secret  %terminal:dev  8m left');
    should(out.messages[0]).containEql('the agent says: sudo password to install the package');
  });

  it('should say when nothing is waiting, and print the protocol payload with --json', async () => {
    // Arrange
    const empty = rig({}, new FakeInputGateway([]));
    const json = rig();

    // Act
    await new InputController(empty.ports).list(options);
    await new InputController(json.ports).list({ ...options, json: true });

    // Assert
    should(empty.out.messages).deepEqual(['No input requests are waiting.']);
    should(JSON.parse(json.out.messages[0] ?? '').requests).have.length(1);
  });

  it('should decline a request by its card reference', async () => {
    // Arrange
    const { ports, gateway, out } = rig();

    // Act
    await new InputController(ports).cancel('!A7', options);

    // Assert
    should(gateway.cancelled).deepEqual([{ sessionId: SESSION, requestId: REQUEST_ID }]);
    should(out.messages).deepEqual(['Declined !A7.']);
  });
});
