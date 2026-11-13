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
import { readFileSync } from 'node:fs';
import should from 'should';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '../../../../../core/kernel/testing/host.ts';
import { ConnectionsPort, HOSTED_RELAY_DIRECTORY_ORIGIN } from '../../../contract/index.ts';
import manifest from '../../../manifest.ts';
import { buildConnections } from '../../../daemon/index.ts';
import {
  chooseRelayCarrierSources,
  chooseRelayCarrierSource,
  describeAbsentRelayCarrier,
  describeRelayCarrierPosture,
  dialledRelayUrl,
  NO_RELAY_DIRECTORY,
  PAIRING_REACH_NOTICE,
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
} from '../../../daemon/lib/relay/discovery.ts';
import { DaemonRelayConfigSchema } from '../../../daemon/lib/runtime/relay-config.ts';
import {
  ConfiguredRelayCarrierSchema,
  DiscoveredRelayCarrierSchema,
} from '../../../daemon/lib/runtime/relay-config.ts';

const CONFIG_FILE = 'connections.yaml';
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

  it('R131 should read null as the kill switch and anything unexpected as ignorance', () => {
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
  it('R216 should dial the advertised relay when this daemon has none of its own', () => {
    // Act — the whole fix: no configured block, an advertisement, a carrier.
    const source = chooseRelayCarrierSource(undefined, available(HOSTED));

    // Assert
    should(source.kind).equal('discovered');
    should(dialledRelayUrl(source)).equal(HOSTED);
    // The SAME schema an operator's document goes through, so the redial cadence cannot diverge.
    should(source).match({ config: { url: HOSTED, enabled: true, reconnectSeconds: configured().reconnectSeconds } });
  });

  it('R205 should never overwrite a relay the operator chose, including one they switched off', () => {
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

  it('R202 should fail closed on every answer that is not an address, and say which', () => {
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

  it('R205 should not ask the directory at all when a relay is configured', () => {
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
      { kind: 'relay', url: 'https://mine.example', source: 'configured' },
      { kind: 'relay', url: HOSTED },
    ]);
  });

  it('R173 should not read discovery for a switched-off discovery entry', () => {
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

    should(publishedDaemonCarriers(undefined, [source])).deepEqual([
      { kind: 'relay', url: 'https://relay.example', source: 'configured' },
    ]);
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
      ['https://box.example?token=one', /origin without a path, query or fragment/u],
    ] as const) {
      should(publishableDirectCarrier(url)).match({ kind: 'refused', reason });
    }
  });

  it('R172 should refuse the boot when a written-down relay and the advertised one are the same rendezvous', () => {
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
      { kind: 'relay', url: 'https://mine.example', source: 'configured' },
      { kind: 'relay', url: HOSTED },
    ]);
  });
});

describe('what the daemon says about its carrier', () => {
  it('R206 should name the posture in one line, and say which relay', () => {
    // Assert — hosted and self-hosted differ in who can switch the carrier off, so naming which is
    // the entire value of the line.
    should(describeRelayCarrierPosture(chooseRelayCarrierSource(undefined, available(HOSTED)), CONFIG_FILE)).match(
      /^carrier {6}hosted — https:\/\/relay\.example, from Ferretry/u,
    );
    should(describeRelayCarrierPosture(chooseRelayCarrierSource(configured(), NO_RELAY_DIRECTORY), CONFIG_FILE)).match(
      /^carrier {6}self-hosted — https:\/\/relay\.example, from connections\.yaml$/u,
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
    should(lines).have.length(5);
    should(lines[0]).match(/^no relay carrier — /u);
    should(lines[1]).match(
      /^No relay is available, so another device cannot pair yet; this daemon is bound to 192\.168\.1\.10, but it refuses direct connections from other machines\.$/u,
    );
    should(lines[2]).equal('Keep the daemon on a loopback listener ("fyd --host 127.0.0.1").');
    should(lines[3]).match(
      /^Restart to ask the hosted relay directory again; .*top-level "relay" entry in config\/connections\.yaml/u,
    );
    should(lines[4]).match(
      /^5\.0 has no separate public-address setting, and widening the listener does not enable direct connections/u,
    );
  });

  it.each(['127.0.0.1', '::1', 'localhost', '[::1]'])(
    'should say a daemon on %s with no carrier cannot pair another device yet, and name the way out',
    host => {
      // Act — the worst case, and the one every fresh install is in.
      const lines = describeAbsentRelayCarrier({
        source: chooseRelayCarrierSource(undefined, NO_RELAY_DIRECTORY),
        carrierDetail: undefined,
        configFile: CONFIG_FILE,
        host,
      });

      // Assert — the consequence, the one supported listener, the relay correction and the limit.
      should(lines).have.length(5);
      should(lines[1]).equal(
        `No relay is available, so another device cannot pair yet; this daemon is bound to ${host}, and a browser on this machine can pair locally.`,
      );
      should(lines[2]).equal('Keep the daemon on a loopback listener ("fyd --host 127.0.0.1").');
      should(lines[3]).equal(
        'Restart to ask the hosted relay directory again; to stop depending on it, add the top-level "relay" entry in ' +
          'config/connections.yaml naming a rendezvous you operate (docs/cloudflare-relay-self-hosting.md).',
      );
      should(lines[4]).equal(
        '5.0 has no separate public-address setting, and widening the listener does not enable direct connections from other machines.',
      );
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
    should(lines[3]).equal(
      'This relay is explicitly configured, so correct or remove the top-level "relay" entry in config/connections.yaml (it is what this daemon dials), then restart.',
    );
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

  it('G158 should keep the remedy separate so a surface can state the reason its own way', () => {
    // Assert — `--check` names the posture in its own line and would otherwise say it twice.
    should(
      relayCarrierRemedy(chooseRelayCarrierSource(undefined, { kind: 'disabled' }), CONFIG_FILE, '192.168.1.10'),
    ).have.length(4);
  });

  it.each([
    ['discovered', chooseRelayCarrierSource(undefined, NO_RELAY_DIRECTORY)],
    ['configured', chooseRelayCarrierSource(configured(), RELAY_DIRECTORY_NOT_ASKED)],
  ] as const)('should never prescribe a v4 remedy 5.0 cannot honour for a %s source', (_name, source) => {
    // Assert — "carriers", "publicUrl" and the wildcard bind do not exist in 5.0: the strict schema refuses them
    // and the listener refuses a peer off this machine, so a sentence naming them sends the reader nowhere.
    for (const host of ['127.0.0.1', '::1', 'localhost', '192.168.1.10']) {
      const said = [
        ...relayCarrierRemedy(source, CONFIG_FILE, host),
        ...describeAbsentRelayCarrier({ source, carrierDetail: undefined, configFile: CONFIG_FILE, host }),
      ].join('\n');
      should(said).not.match(/carriers|publicUrl|0\.0\.0\.0/u);
      should(said).containEql('"relay" entry in config/connections.yaml');
    }
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

  it('should say what first contact needs, without claiming pairing is always direct', () => {
    // This assertion used to demand the opposite sentence — "pairing goes straight to the daemon" —
    // on the reasoning that a relayed session is opened with a grant pairing has not issued yet.
    // `docs/relay-protocol.md` §14 built a pairing session, so the notice states the CONDITION that
    // is left: direct first, the dialled relay for a device that cannot reach the address, and the
    // address as the only way in when nothing is dialled.
    should(PAIRING_REACH_NOTICE).match(/tries this machine’s own address first/u);
    should(PAIRING_REACH_NOTICE).match(/VPN|tailnet/u);
    should(PAIRING_REACH_NOTICE).match(/through Ferretry’s hosted relay/u);
    // And it does NOT promise a first pairing over a rendezvous the operator runs: a device that has
    // never paired can discover the hosted advertisement and nothing else. Overclaiming in that
    // direction would be the same defect as the retired sentence, pointed the other way.
    should(PAIRING_REACH_NOTICE).match(/cannot yet be found by a device that has never paired/u);
    // The retired claim, named so a rewording cannot bring it back.
    should(PAIRING_REACH_NOTICE).not.match(/always/u);
  });
});

describe('the discovery origin both ends read', () => {
  const connections = new URL('../../../', import.meta.url).pathname;
  const sourceOf = (relative: string) => readFileSync(`${connections}${relative}`, 'utf8');
  /** Every non-test source file the daemon and the app half of Connections ship. */
  const shipped = (): readonly string[] =>
    ['daemon', 'app', 'contract', 'worker/src'].flatMap(folder =>
      [...new Bun.Glob('**/*.{ts,tsx}').scanSync({ cwd: `${connections}${folder}` })]
        .filter(file => !file.includes('/generated/'))
        .map(file => `${connections}${folder}/${file}`),
    );

  it('R13 the discovery origin names a service, not a person: a bare https origin, the same string for every daemon', async () => {
    const origin = new URL(HOSTED_RELAY_DIRECTORY_ORIGIN);
    should(origin.protocol).equal('https:');
    should(origin.origin).equal(HOSTED_RELAY_DIRECTORY_ORIGIN);
    should(`${origin.username}${origin.password}${origin.search}${origin.hash}`).equal('');
    // No daemon, device or pairing identifier can be part of a shared service address.
    should(HOSTED_RELAY_DIRECTORY_ORIGIN).not.match(/fy_(daemon|device)|[?#@]/u);
    // Two daemons with two identities ask and advertise exactly the same directory.
    const askedBy = async (daemonId: string) => {
      const host = await testHost({
        plugins: [
          implementDaemon(manifest, {
            build: ctx =>
              buildConnections(ctx, {
                identity: { daemonId, sign: async () => Promise.reject(new Error('unused')) },
                openSession: (layer, key, peer) => layer.open(key, peer),
              }),
          }),
        ],
      });
      const advertised = host.provided(ConnectionsPort).advertisement().directoryOrigin;
      await host.stop();
      return advertised;
    };
    should(await askedBy(`fy_daemon_${'a'.repeat(43)}`)).equal(HOSTED_RELAY_DIRECTORY_ORIGIN);
    should(await askedBy(`fy_daemon_${'b'.repeat(43)}`)).equal(HOSTED_RELAY_DIRECTORY_ORIGIN);
  });

  it('R203 both ends import the same discovery origin, it is an origin and never a carrier, and no relay address is compiled in', () => {
    // The daemon's read, and the app build's define, both come from the one constant of the Connections contract.
    should(sourceOf('daemon/index.ts')).match(/HOSTED_RELAY_DIRECTORY_ORIGIN[^;]*from '\.\.\/contract\/index\.ts'/su);
    const vite = readFileSync(new URL('../../../../../app/vite.config.ts', import.meta.url), 'utf8');
    should(vite).match(
      /import \{ HOSTED_RELAY_DIRECTORY_ORIGIN \} from '\.\.\/plugins\/connections\/contract\/hosted-directory\.ts'/u,
    );
    should(vite).match(/__FY_RELAY_DIRECTORY__/u);
    // An origin, never a carrier: the daemon reads an advertisement FROM it and publishes only what that says.
    should(relayAdvertisementAddress(HOSTED_RELAY_DIRECTORY_ORIGIN)).equal(
      `${HOSTED_RELAY_DIRECTORY_ORIGIN}${RELAY_ADVERTISEMENT_PATH}`,
    );
    should(publishedDaemonCarriers('https://box.example', [{ kind: 'direct-only', reason: 'no directory' }])).deepEqual(
      [{ kind: 'direct', url: 'https://box.example' }],
    );
    // No relay address is compiled into either end: the service host is spelled in exactly one module, and no
    // shipped source writes a rendezvous (`wss://…`) literal.
    const serviceHost = new URL(HOSTED_RELAY_DIRECTORY_ORIGIN).host;
    const spelledIn = shipped().filter(file => readFileSync(file, 'utf8').includes(serviceHost));
    should(spelledIn.map(file => file.slice(connections.length))).deepEqual(['contract/hosted-directory.ts']);
    for (const file of shipped()) should(readFileSync(file, 'utf8')).not.match(/['"`]wss:\/\/[a-z0-9.-]+\.[a-z]{2,}/u);
  });
});
