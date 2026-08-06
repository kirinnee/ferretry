/**
 * WHERE THE CARRIER COMES FROM WHEN NOBODY CONFIGURED ONE.
 *
 * The defect this guards is not subtle and it is not theoretical: a fresh install binds loopback,
 * dials nothing, and is therefore reachable from no device but this one — which the person holding
 * the phone reads as "I cannot pair". Every case below is one half of the sentence that has to stay
 * true: the advertised carrier is taken, an operator's own choice is never overwritten, and every
 * failure narrows to direct-only WITH something a reader can act on.
 */

import { describe, it } from 'bun:test';
import { WILDCARD_BIND_HOST } from '@ferretry/protocol';
import should from 'should';
import {
  chooseRelayCarrierSource,
  describeAbsentRelayCarrier,
  describeRelayCarrierPosture,
  dialledRelayUrl,
  NO_RELAY_DIRECTORY,
  PAIRING_IS_ALWAYS_DIRECT,
  parseRelayAdvertisement,
  RELAY_ADVERTISEMENT_PATH,
  RELAY_DIRECTORY_NOT_ASKED,
  RELAY_DISCOVERY_TIMEOUT_MS,
  type RelayAdvertisement,
  relayAdvertisementAddress,
  relayCarrierRemedy,
} from '../../../src/lib/relay/discovery.ts';
import { DaemonRelayConfigSchema } from '../../../src/lib/runtime/config.ts';

const CONFIG_FILE = '/tmp/state/config/daemon.json';
const HOSTED = 'https://relay.example';

const available = (relayUrl: string): RelayAdvertisement => ({ kind: 'available', relayUrl });
const configured = (patch: Record<string, unknown> = {}) => DaemonRelayConfigSchema.parse({ url: HOSTED, ...patch });

describe('the relay advertisement', () => {
  it('should ask the protocol’s own discovery path, on an endpoint the daemon may dial', () => {
    // Assert — the path is §13's, and the origin goes through the same endpoint rule the carrier does.
    should(relayAdvertisementAddress(HOSTED)).equal(`${HOSTED}${RELAY_ADVERTISEMENT_PATH}`);
    should(relayAdvertisementAddress('http://127.0.0.1:8787')).equal(
      `http://127.0.0.1:8787${RELAY_ADVERTISEMENT_PATH}`,
    );
    // Insecure off loopback, a query, and something that is not a URL at all are all refused rather
    // than asked: a build pointed at one of these has a defect, and dialling would hide it.
    should(relayAdvertisementAddress('http://relay.example')).be.undefined();
    should(relayAdvertisementAddress('https://relay.example?token=1')).be.undefined();
    should(relayAdvertisementAddress('relay.example')).be.undefined();
  });

  it('should read null as the kill switch and anything unexpected as ignorance', () => {
    // Assert — three genuinely different answers, and never a guess.
    should(parseRelayAdvertisement({ version: 1, relayUrl: HOSTED })).deepEqual(available(HOSTED));
    should(parseRelayAdvertisement({ version: 1, relayUrl: null })).deepEqual({ kind: 'disabled' });
    for (const answer of [
      { version: 2, relayUrl: HOSTED },
      { version: 1, relayUrl: 'http://relay.example' },
      { version: 1 },
      { version: 1, relayUrl: HOSTED, extra: true },
      'not a document',
      null,
    ]) {
      should(parseRelayAdvertisement(answer)).match({ kind: 'undetermined', reason: /cannot read/u });
    }
  });

  it('should keep the timeout short enough that a dead directory cannot hold a boot', () => {
    // Assert — a boot waits for this before it says anything about a carrier.
    should(RELAY_DISCOVERY_TIMEOUT_MS).be.belowOrEqual(5_000);
  });
});

describe('choosing the carrier', () => {
  it('should dial the advertised relay when this daemon has none of its own', () => {
    // Act — the whole fix: no configured block, an advertisement, a carrier.
    const source = chooseRelayCarrierSource(undefined, available(HOSTED));

    // Assert
    should(source.kind).equal('discovered');
    should(dialledRelayUrl(source)).equal(HOSTED);
    // The SAME schema an operator's document goes through, so the redial cadence cannot diverge.
    should(source).match({ config: { url: HOSTED, enabled: true, reconnectSeconds: configured().reconnectSeconds } });
  });

  it('should never overwrite a relay the operator chose, including one they switched off', () => {
    // Act — an advertisement that disagrees with the document, in both directions.
    const own = chooseRelayCarrierSource(configured({ url: 'https://mine.example' }), available(HOSTED));
    const off = chooseRelayCarrierSource(configured({ enabled: false }), available(HOSTED));

    // Assert — the operator's address wins, and `enabled: false` STAYS off. Re-enabling it here
    // would turn somebody's emergency stop into a suggestion.
    should(own).match({ kind: 'configured', config: { url: 'https://mine.example' } });
    should(dialledRelayUrl(own)).equal('https://mine.example');
    should(off.kind).equal('configured');
    should(dialledRelayUrl(off)).be.undefined();
  });

  it('should fail closed on every answer that is not an address, and say which', () => {
    // Act
    const disabled = chooseRelayCarrierSource(undefined, { kind: 'disabled' });
    const unreachable = chooseRelayCarrierSource(undefined, NO_RELAY_DIRECTORY);
    // An address that parsed as an advertisement but is not one a daemon may dial. The
    // advertisement schema already refuses these, so this is the belt on top of the braces.
    const undialable = chooseRelayCarrierSource(undefined, available('http://relay.example'));

    // Assert — three sentences, not one, because they need three different things done about them.
    should(disabled).match({ kind: 'direct-only', reason: /switched off/u });
    should(unreachable).match({ kind: 'direct-only', reason: /no relay directory to ask/u });
    should(undialable).match({ kind: 'direct-only', reason: /not one this daemon may dial/u });
    should(dialledRelayUrl(disabled)).be.undefined();
  });

  it('should not ask the directory at all when a relay is configured', () => {
    // Assert — the sentinel the composition root passes instead of a network read, and the reason
    // it carries. Asking anyway would be a request nobody needed and an answer nobody may use.
    should(RELAY_DIRECTORY_NOT_ASKED).match({ kind: 'undetermined', reason: /own relay configured/u });
    should(chooseRelayCarrierSource(configured(), RELAY_DIRECTORY_NOT_ASKED).kind).equal('configured');
  });
});

describe('what the daemon says about its carrier', () => {
  it('should name the posture in one line, and say which relay', () => {
    // Assert — hosted and self-hosted differ in who can switch the carrier off, so naming which is
    // the entire value of the line.
    should(describeRelayCarrierPosture(chooseRelayCarrierSource(undefined, available(HOSTED)), CONFIG_FILE)).match(
      /^carrier {6}hosted — https:\/\/relay\.example, from Ferretry/u,
    );
    should(describeRelayCarrierPosture(chooseRelayCarrierSource(configured(), NO_RELAY_DIRECTORY), CONFIG_FILE)).match(
      /^carrier {6}self-hosted — https:\/\/relay\.example, from \/tmp/u,
    );
    should(
      describeRelayCarrierPosture(
        chooseRelayCarrierSource(configured({ enabled: false }), NO_RELAY_DIRECTORY),
        CONFIG_FILE,
      ),
    ).match(/^carrier {6}direct-only — the relay https:\/\/relay\.example is switched off/u);
    should(describeRelayCarrierPosture(chooseRelayCarrierSource(undefined, NO_RELAY_DIRECTORY), CONFIG_FILE)).match(
      /^carrier {6}direct-only — no relay could be discovered/u,
    );
  });

  it('should tell a reader the consequence and what to do, not only the reason', () => {
    // Act — the notice a boot prints when it dials nothing, on a daemon reachable on its LAN.
    const lines = describeAbsentRelayCarrier({
      source: chooseRelayCarrierSource(undefined, NO_RELAY_DIRECTORY),
      carrierDetail: undefined,
      configFile: CONFIG_FILE,
      host: '192.168.1.10',
    });

    // Assert — THE OLD NOTICE WAS THE FIRST LINE ALONE, which told somebody whose phone could not
    // reach this daemon nothing they could act on.
    should(lines).have.length(3);
    should(lines[0]).match(/^no relay carrier — /u);
    should(lines[1]).match(/reachable only from this machine/u);
    should(lines[2]).match(/relay directory again/u);
    should(lines[2]).containEql(CONFIG_FILE);
  });

  it.each(['127.0.0.1', '::1', 'localhost', '[::1]'])(
    'should say a daemon on %s with no carrier cannot be paired with at all, and name the way out',
    host => {
      // Act — the worst case, and the one every fresh install is in.
      const lines = describeAbsentRelayCarrier({
        source: chooseRelayCarrierSource(undefined, NO_RELAY_DIRECTORY),
        carrierDetail: undefined,
        configFile: CONFIG_FILE,
        host,
      });

      // Assert — naming only the relay would leave the reader exactly as stuck: pairing is always
      // direct, so this daemon cannot be paired with from another device however the relay ends up.
      should(lines).have.length(4);
      should(lines[1]).containEql(host);
      should(lines[1]).match(/nothing can pair with it either/u);
      // Bind everywhere before advertising one dialable URL. The wildcard keeps loopback working,
      // so the host's own command can still spend the owner-only credential after applying the fix.
      should(lines[2]).match(/^to pair: set "host" in/u);
      should(lines[2]).containEql(CONFIG_FILE);
      should(lines[2]).containEql(`"${WILDCARD_BIND_HOST}"`);
      should(lines[2]).containEql('"publicUrl"');
      should(lines[3]).match(/^to stay reachable once that browser leaves the network/u);
    },
  );

  it('should prefer the carrier’s own refusal when it had one', () => {
    // Act — a configured relay the carrier itself refused, e.g. a fingerprint no rendezvous can address.
    const lines = describeAbsentRelayCarrier({
      source: chooseRelayCarrierSource(configured(), RELAY_DIRECTORY_NOT_ASKED),
      carrierDetail: 'is not a daemon fingerprint a rendezvous can be addressed by',
      configFile: CONFIG_FILE,
      host: '192.168.1.10',
    });

    // Assert — the specific sentence survives, and the remedy points at the block being dialled.
    should(lines[0]).containEql('not a daemon fingerprint');
    should(lines[2]).match(/correct it or remove it/u);
  });

  it('should fall back to a stated absence rather than an empty reason', () => {
    // Assert — a configured source with no refusal reported is a case nothing should print blank.
    should(
      describeAbsentRelayCarrier({
        source: chooseRelayCarrierSource(configured(), RELAY_DIRECTORY_NOT_ASKED),
        carrierDetail: undefined,
        configFile: CONFIG_FILE,
        host: '192.168.1.10',
      })[0],
    ).containEql('no reason reported');
  });

  it('should keep the remedy separate so a surface can state the reason its own way', () => {
    // Assert — `--check` names the posture in its own line and would otherwise say it twice.
    should(
      relayCarrierRemedy(chooseRelayCarrierSource(undefined, { kind: 'disabled' }), CONFIG_FILE, '192.168.1.10'),
    ).have.length(2);
  });

  it('should never print the same sentence for a switch that is off and a directory it could not reach', () => {
    // Arrange — three ways to end up with no carrier that need three different things done.
    const said = [
      chooseRelayCarrierSource(undefined, { kind: 'disabled' }),
      chooseRelayCarrierSource(undefined, { kind: 'undetermined', reason: 'this daemon could not reach it' }),
      chooseRelayCarrierSource(configured({ enabled: false }), RELAY_DIRECTORY_NOT_ASKED),
    ].map(
      source =>
        describeAbsentRelayCarrier({
          source,
          carrierDetail:
            source.kind === 'configured'
              ? `the configured relay ${HOSTED} is switched off in this daemon's configuration`
              : undefined,
          configFile: CONFIG_FILE,
          host: '192.168.1.10',
        })[0],
    );

    // Assert — a deliberate stop and a service nobody could reach are opposite faults. Reporting
    // either as the other sends the reader somewhere useless, so the three sentences are distinct
    // and each names what actually happened.
    should(new Set(said).size).equal(3);
    should(said[0]).match(/Ferretry’s relay is switched off/u);
    should(said[1]).match(/could not reach it/u);
    should(said[2]).match(/switched off in this daemon’s|switched off in this daemon's/u);
  });

  it('should say that pairing is direct wherever a carrier is reported', () => {
    // Assert — a relayed session is opened with the grant pairing has not issued yet, so a relay
    // that is up does NOT mean a phone can pair from anywhere. Somebody told otherwise concludes
    // the product is broken.
    should(PAIRING_IS_ALWAYS_DIRECT).match(/straight to the daemon/u);
    should(PAIRING_IS_ALWAYS_DIRECT).match(/VPN|tailnet/u);
  });
});
