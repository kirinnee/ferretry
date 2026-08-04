import { describe, it } from 'bun:test';
import should from 'should';
import {
  defaultBindRetryPolicy,
  EXIT_ADDRESS_CONFLICT,
  EXIT_ALREADY_RUNNING,
  foreignAdvertisementNotice,
  healthEndpoint,
  identifyAddressOccupant,
  PORT_CANDIDATE_LIMIT,
  portCandidates,
  refuseExhaustedCandidates,
  refuseHeldStateHome,
  refuseOccupiedAddress,
  refuseUnbindableAddress,
  shouldRetryBind,
} from '../../../src/lib/runtime/boot.ts';
import { healthViewFixture } from '../../fixtures/health-view.ts';

describe('daemon boot policy', () => {
  it('should build one health endpoint for either form of base URL', () => {
    // Act + Assert
    should(healthEndpoint('http://127.0.0.1:7431')).equal('http://127.0.0.1:7431/v1/health');
    should(healthEndpoint('http://127.0.0.1:7431/')).equal('http://127.0.0.1:7431/v1/health');
    should(healthEndpoint('http://127.0.0.1:7431//')).equal('http://127.0.0.1:7431/v1/health');
  });

  it('should retry only a bind conflict that can fit before the deadline', () => {
    // Arrange
    const policy = defaultBindRetryPolicy();

    // Act + Assert
    should(shouldRetryBind({ code: 'EADDRINUSE' }, 100, 1_000, 1, policy)).be.true();
    should(shouldRetryBind(new Error('address already in use'), 100, 1_000, 1, policy)).be.true();
    should(shouldRetryBind(new Error('permission denied'), 100, 1_000, 1, policy)).be.false();
    should(shouldRetryBind({ code: 'EADDRINUSE' }, 500, 1_000, 1, policy)).be.true();
    should(shouldRetryBind({ code: 'EADDRINUSE' }, 501, 1_000, 1, policy)).be.false();
    should(shouldRetryBind({ code: 'EADDRINUSE' }, 100, 1_000, policy.maxAttempts, policy)).be.false();
  });

  it('should believe a responder is one of these daemons only on its own health report', () => {
    // Act
    const ours = identifyAddressOccupant({
      kind: 'answered',
      status: 200,
      body: healthViewFixture({ version: '3.2.1', pid: 8_808 }),
    });

    // Assert
    should(ours).deepEqual({ kind: 'daemon', version: '3.2.1', pid: 8_808 });
  });

  it('should call every other answer a stranger, including one it cannot identify', () => {
    // Arrange: the ways an address answers without being one of these daemons.
    const unauthorized = identifyAddressOccupant({ kind: 'answered', status: 401, body: { error: 'unauthorized' } });
    const somethingElse = identifyAddressOccupant({ kind: 'answered', status: 200, body: { status: 'ok' } });
    const noBody = identifyAddressOccupant({ kind: 'answered', status: 200, body: undefined });
    // A body that WOULD identify a daemon, refused because the status did not: a surface answering
    // 503 with a cached report is not a daemon willing to serve this address.
    const wrongStatus = identifyAddressOccupant({ kind: 'answered', status: 503, body: healthViewFixture() });

    // Assert
    for (const occupant of [unauthorized, somethingElse, noBody, wrongStatus]) {
      should(occupant.kind).equal('stranger');
      // The evidence is the whole point of separating these from an incumbent: a human has to be
      // able to tell a foreign supervisor from an unrelated web server.
      should(occupant).have.property('evidence').which.is.a.String();
    }
    should(unauthorized)
      .have.property('evidence')
      .match(/HTTP 401/u);
  });

  it('should clear the way only for a refused connection, and fail closed on an inconclusive probe', () => {
    // Act
    const vacant = identifyAddressOccupant({ kind: 'refused' });
    const inconclusive = identifyAddressOccupant({ kind: 'unreachable', detail: 'TimeoutError: timed out' });

    // Assert — booting a second daemon over a live one because identification was inconclusive is
    // the one outcome that cannot be recovered from: both would own state neither can see.
    should(vacant).deepEqual({ kind: 'vacant' });
    should(inconclusive.kind).equal('stranger');
    should(inconclusive)
      .have.property('evidence')
      .match(/did not answer/u);
  });

  it('should answer an occupied address with a different code and remedy for each occupant', () => {
    // Act
    const incumbent = refuseOccupiedAddress({
      daemonName: 'fyd',
      clientName: 'fy',
      url: 'http://127.0.0.1:7431',
      configFile: '/home/a/.ferretry/config/daemon.json',
      occupant: { kind: 'daemon', version: '1.0.0', pid: 42 },
    });
    const conflict = refuseOccupiedAddress({
      daemonName: 'fyd',
      clientName: 'fy',
      url: 'http://127.0.0.1:7431',
      configFile: '/home/a/.ferretry/config/daemon.json',
      occupant: { kind: 'stranger', evidence: 'it answered HTTP 401' },
    });

    // Assert — the whole defect was an exit code with no message, so the MESSAGE is what is asserted.
    should(incumbent.exitCode).equal(EXIT_ALREADY_RUNNING);
    should(incumbent.message).match(/already serving http:\/\/127\.0\.0\.1:7431/u);
    should(incumbent.message).match(/pid 42/u);
    should(incumbent.message).match(/fy daemon stop/u);
    should(conflict.exitCode).equal(EXIT_ADDRESS_CONFLICT);
    should(conflict.exitCode).not.equal(incumbent.exitCode);
    should(conflict.message).match(/it answered HTTP 401/u);
    // Both name the edit that fixes it; a refusal that does not is a refusal nobody can act on.
    for (const refusal of [incumbent, conflict])
      should(refusal.message).match(/"port" in \/home\/a\/\.ferretry\/config\/daemon\.json/u);
  });

  it('should say why a held state home stopped the boot instead of exiting in silence', () => {
    // Act
    const refusal = refuseHeldStateHome('fyd', 'fy', '/home/a/.ferretry/daemon.lock');

    // Assert
    should(refusal.exitCode).equal(EXIT_ALREADY_RUNNING);
    should(refusal.message).match(/\/home\/a\/\.ferretry\/daemon\.lock/u);
    should(refusal.message).match(/fy daemon stop/u);
    should(refusal.message).match(/FY_HOME/u);
  });

  it('should offer a short consecutive run of addresses and stop at the top of the port space', () => {
    // Act
    const fromPreferred = portCandidates(7_431);
    const nearTheCeiling = portCandidates(65_534);
    const explicitLimit = portCandidates(7_431, 3);

    // Assert — consecutive and guessable, because an operator has to be able to find this daemon.
    should(fromPreferred).have.length(PORT_CANDIDATE_LIMIT);
    should(fromPreferred[0]).equal(7_431);
    should(fromPreferred[1]).equal(7_432);
    // It stops rather than wrapping: a wrapped sequence would offer privileged ports it cannot bind.
    should(nearTheCeiling).deepEqual([65_534, 65_535]);
    should(explicitLimit).deepEqual([7_431, 7_432, 7_433]);
  });

  it('should report a host with no free address as a conflict rather than searching wider', () => {
    // Act
    const refusal = refuseExhaustedCandidates('fyd', [7_431, 7_432, 7_433], '/home/a/.ferretry/config/daemon.json');

    // Assert
    should(refusal.exitCode).equal(EXIT_ADDRESS_CONFLICT);
    should(refusal.message).match(/7431 to 7433/u);
    should(refusal.message).match(/"port"/u);
  });

  it('should report an unbindable address as a refusal that names the reason', () => {
    // Act
    const refusal = refuseUnbindableAddress('http://0.0.0.0:80', 'permission denied', '/etc/daemon.json');

    // Assert — a stack trace about a socket says none of what an operator needs to know.
    should(refusal.exitCode).equal(EXIT_ADDRESS_CONFLICT);
    should(refusal.message).match(/http:\/\/0\.0\.0\.0:80/u);
    should(refusal.message).match(/permission denied/u);
  });

  it('should state a divergent advertisement without refusing the deployment that meant it', () => {
    // Act
    const notice = foreignAdvertisementNotice(
      'http://127.0.0.1:7431',
      'https://box.example.test',
      '/home/a/.ferretry/config/daemon.json',
    );

    // Assert
    should(notice).match(/binds http:\/\/127\.0\.0\.1:7431/u);
    should(notice).match(/advertises https:\/\/box\.example\.test/u);
    should(notice).match(/remove "publicUrl"/u);
  });
});
