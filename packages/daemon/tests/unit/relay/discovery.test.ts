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
  chooseRelayCarrierSources,
  chooseRelayCarrierSource,
  describeAbsentRelayCarrier,
  describeRelayCarrierPosture,
  dialledRelayUrl,
  NO_RELAY_DIRECTORY,
  PAIRING_IS_ALWAYS_DIRECT,
  parseRelayAdvertisement,
  publishableDirectCarrier,
  publishedDaemonCarriers,
  RELAY_ADVERTISEMENT_PATH,
  RELAY_DIRECTORY_NOT_ASKED,
  RELAY_DISCOVERY_TIMEOUT_MS,
  type RelayAdvertisement,
  relayAdvertisementAddress,
  type RelayCarrierSource,
  relayCarriersNeedDiscovery,
  relayCarrierRemedy,
  type ResolvedRelayCarriers,
} from '../../../src/lib/relay/discovery.ts';
import { DaemonRelayConfigSchema } from '../../../src/lib/runtime/config.ts';
import { ConfiguredRelayCarrierSchema, DiscoveredRelayCarrierSchema } from '../../../src/lib/runtime/carriers.ts';

const CONFIG_FILE = '/tmp/state/config/daemon.json';
const HOSTED = 'https://relay.example';

const available = (relayUrl: string): RelayAdvertisement => ({ kind: 'available', relayUrl });
const configured = (patch: Record<string, unknown> = {}) => DaemonRelayConfigSchema.parse({ url: HOSTED, ...patch });

/** The resolved list, insisting on the resolution: a refusal reaching an assertion is the failure. */
const resolvedSources = (resolved: ResolvedRelayCarriers): readonly RelayCarrierSource[] => {
  if (resolved.kind === 'refused') throw new Error(`expected resolved carriers, got a refusal: ${resolved.reason}`);
  return resolved.sources;
};

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

  it('should resolve every ordinary relay entry in operator order and publish every dialled address', () => {
    const own = ConfiguredRelayCarrierSchema.parse({ kind: 'relay', url: 'https://mine.example' });
    const discovered = DiscoveredRelayCarrierSchema.parse({
      kind: 'relay',
      source: 'discovery',
      reconnectSeconds: 17,
    });
    const off = ConfiguredRelayCarrierSchema.parse({
      kind: 'relay',
      url: 'https://off.example',
      enabled: false,
    });

    should(relayCarriersNeedDiscovery([own, discovered, off])).be.true();
    const resolved = chooseRelayCarrierSources([own, discovered, off], available(HOSTED));
    should(resolved.kind).equal('resolved');
    const sources = resolvedSources(resolved);
    should(sources).match([
      { kind: 'configured', config: { url: 'https://mine.example' } },
      { kind: 'discovered', config: { url: HOSTED, reconnectSeconds: 17 } },
      { kind: 'configured', config: { url: 'https://off.example', enabled: false } },
    ]);
    should(publishedDaemonCarriers('http://box.lan:7431', sources)).deepEqual([
      { kind: 'direct', url: 'http://box.lan:7431' },
      { kind: 'relay', url: 'https://mine.example' },
      { kind: 'relay', url: HOSTED },
    ]);
  });

  it('should not read discovery for a switched-off discovery entry', () => {
    const off = DiscoveredRelayCarrierSchema.parse({ kind: 'relay', source: 'discovery', enabled: false });
    should(relayCarriersNeedDiscovery([off])).be.false();
    const sources = resolvedSources(chooseRelayCarrierSources([off], RELAY_DIRECTORY_NOT_ASKED));
    should(sources).match([{ kind: 'direct-only', reason: /switched off/u }]);
    should(publishedDaemonCarriers('https://box.example', sources)).deepEqual([
      { kind: 'direct', url: 'https://box.example' },
    ]);
  });

  it('should publish relays without inventing a direct origin when the bind has no dialable one', () => {
    const source: RelayCarrierSource = {
      kind: 'configured',
      config: DaemonRelayConfigSchema.parse({ url: 'https://relay.example' }),
    };

    should(publishedDaemonCarriers(undefined, [source])).deepEqual([{ kind: 'relay', url: 'https://relay.example' }]);
  });

  it('should accept a daemon origin and explain every wider URL shape the carrier wire refuses', () => {
    should(publishableDirectCarrier('https://box.example')).deepEqual({
      kind: 'ok',
      url: 'https://box.example',
    });
    for (const [url, reason] of [
      ['https://box.example/ferretry', /origin without a path/u],
      ['ftp://box.example', /must use http or https/u],
      ['https://user:password@box.example', /may not carry credentials/u],
      ['https://box.example?token=one', /may not carry a query or a fragment/u],
    ] as const) {
      should(publishableDirectCarrier(url)).match({ kind: 'refused', reason });
    }
  });

  it('should refuse the boot when a written-down relay and the advertised one are the same rendezvous', () => {
    // Arrange — both entries are legal on their own and the document schema cannot see the collision:
    // the second entry has no address in it until the directory answers.
    const own = ConfiguredRelayCarrierSchema.parse({ kind: 'relay', url: HOSTED });
    const discovered = DiscoveredRelayCarrierSchema.parse({ kind: 'relay', source: 'discovery' });

    // Act
    const resolved = chooseRelayCarrierSources([own, discovered], available(HOSTED));

    // Assert — a refusal instead of a list, so nothing downstream can open the second socket or
    // publish the address twice. Both ways out are named, because a reader told only "duplicate"
    // has to guess which of their two entries the daemon meant.
    should(resolved).match({
      kind: 'refused',
      url: HOSTED,
      reason: /same rendezvous https:\/\/relay\.example/u,
    });
    should(resolved).match({ reason: /Remove the configured entry/u });
    should(resolved).match({ reason: /switch the .* entry off/u });
    // The trailing slash is the same rendezvous, not a second one, and order does not rescue it.
    should(chooseRelayCarrierSources([discovered, own], available(`${HOSTED}/`)).kind).equal('refused');
  });

  it('should not call an address a duplicate when only one of the two is dialled', () => {
    // Arrange — the remedy the refusal above asks for: the same address, one of them switched off.
    const off = ConfiguredRelayCarrierSchema.parse({ kind: 'relay', url: HOSTED, enabled: false });
    const discovered = DiscoveredRelayCarrierSchema.parse({ kind: 'relay', source: 'discovery' });

    // Act
    const resolved = chooseRelayCarrierSources([off, discovered], available(HOSTED));

    // Assert — one socket and one published entry, so there is nothing to refuse. Refusing here would
    // refuse the boot of somebody who had already done what they were asked.
    should(resolved.kind).equal('resolved');
    should(publishedDaemonCarriers('http://box.lan:7431', resolvedSources(resolved))).deepEqual([
      { kind: 'direct', url: 'http://box.lan:7431' },
      { kind: 'relay', url: HOSTED },
    ]);
    // Two entries that dial nothing at all cannot collide either.
    should(
      chooseRelayCarrierSources(
        [off, DiscoveredRelayCarrierSchema.parse({ kind: 'relay', source: 'discovery', enabled: false })],
        available(HOSTED),
      ).kind,
    ).equal('resolved');
  });

  it('should keep distinct rendezvous even when one of them is the advertised address', () => {
    // Assert — the refusal is about ONE address reached twice, never about having several relays.
    const own = ConfiguredRelayCarrierSchema.parse({ kind: 'relay', url: 'https://mine.example' });
    const discovered = DiscoveredRelayCarrierSchema.parse({ kind: 'relay', source: 'discovery' });
    should(
      publishedDaemonCarriers(
        'https://box.example',
        resolvedSources(chooseRelayCarrierSources([own, discovered], available(HOSTED))),
      ),
    ).deepEqual([
      { kind: 'direct', url: 'https://box.example' },
      { kind: 'relay', url: 'https://mine.example' },
      { kind: 'relay', url: HOSTED },
    ]);
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
