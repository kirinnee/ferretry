import { describe, it } from 'bun:test';
import { DAEMON_CAPABILITIES } from '@ferretry/protocol';
import should from 'should';
import { chooseRelayCarrierSource } from '../../../src/lib/relay/discovery.ts';
import { parseDaemonConfig } from '../../../src/lib/runtime/config.ts';
import {
  describeConfiguration,
  describeGrantPosture,
  reachableOffHost,
  renderConfiguration,
} from '../../../src/lib/runtime/provenance.ts';

const CONFIG_FILE = '/home/a/.ferretry/config/daemon.json';
const STATE_HOME = '/home/a/.ferretry';

/** One row by name, or a failure that says the report has no such row. */
function row(rows: ReturnType<typeof describeConfiguration>, name: string): { value: string; origin: string } {
  const found = rows.find(candidate => candidate.name === name);
  if (found === undefined) throw new Error(`the report has no ${name} row`);
  return { value: found.value, origin: found.origin };
}

describe('effective configuration with provenance', () => {
  it('should show the reported disagreement as one value from the file and one from the file', () => {
    // Arrange: the exact document a person lost an evening to — a port they edited beside an
    // advertisement the daemon had written down for them and that no longer tracked it.
    const document = { host: '127.0.0.1', port: 7_431, publicUrl: 'http://127.0.0.1:7337' };

    // Act
    const rows = describeConfiguration({
      document,
      config: parseDaemonConfig(document),
      overrides: {},
      configFile: CONFIG_FILE,
      stateHome: STATE_HOME,
      stateHomeFromEnvironment: false,
    });

    // Assert — with these two lines beside each other the fault is visible in one command, which is
    // the entire reason the origin column exists.
    should(row(rows, 'port')).deepEqual({ value: '7431', origin: 'config file' });
    should(row(rows, 'publicUrl')).deepEqual({ value: 'http://127.0.0.1:7337', origin: 'config file' });
    should(row(rows, 'bind url')).deepEqual({ value: 'http://127.0.0.1:7431', origin: 'derived' });
    // And the rendered report says so outright rather than leaving it to be noticed.
    const rendered = renderConfiguration(rows, parseDaemonConfig(document), CONFIG_FILE);
    should(rendered).match(/binds http:\/\/127\.0\.0\.1:7431 but advertises http:\/\/127\.0\.0\.1:7337/u);
  });

  it('should tell a default from a choice, and a preferred port from a claimed one', () => {
    // Act
    const rows = describeConfiguration({
      document: undefined,
      config: parseDaemonConfig({}),
      overrides: {},
      configFile: CONFIG_FILE,
      stateHome: STATE_HOME,
      stateHomeFromEnvironment: true,
    });

    // Assert
    should(row(rows, 'state home')).deepEqual({ value: STATE_HOME, origin: 'environment' });
    should(row(rows, 'config file').origin).equal('default');
    should(row(rows, 'port').origin).equal('default');
    // "default" alone would hide that this boot is free to move off the address, so the row says it.
    should(rows.find(candidate => candidate.name === 'port')?.note).match(/not claimed/u);
    should(rows.find(candidate => candidate.name === 'publicUrl')?.note).match(/follows host and port/u);
    should(rows.find(candidate => candidate.name === 'config file')?.note).match(/not written yet/u);
    // An unset field is reported too: somebody asking what is in effect is usually asking why
    // something they expected is not happening.
    should(row(rows, 'secretsFile')).deepEqual({ value: '(none)', origin: 'default' });
    should(row(rows, 'analyticsPricing')).deepEqual({ value: '(empty)', origin: 'default' });
  });

  it('should attribute a value named on the command line to the flag that named it', () => {
    // Arrange
    const document = { host: '127.0.0.1', port: 7_431 };
    const overrides = { host: '0.0.0.0', port: 9_100, configFile: '/etc/fyd.json', logLevel: 'warn' } as const;

    // Act
    const rows = describeConfiguration({
      document,
      config: parseDaemonConfig({ host: '0.0.0.0', port: 9_100 }),
      overrides,
      configFile: '/etc/fyd.json',
      stateHome: STATE_HOME,
      stateHomeFromEnvironment: false,
    });

    // Assert
    should(row(rows, 'host')).deepEqual({ value: '0.0.0.0', origin: 'flag' });
    should(row(rows, 'port')).deepEqual({ value: '9100', origin: 'flag' });
    should(row(rows, 'config file')).deepEqual({ value: '/etc/fyd.json', origin: 'flag' });
    should(row(rows, 'log level')).deepEqual({ value: 'warn', origin: 'flag' });
  });

  it('should keep the origin readable however long a value is', () => {
    // Arrange: a state home path far wider than the terminal, which is the common case on a Mac.
    const stateHome = `/Users/somebody/${'directory/'.repeat(12)}.ferretry`;
    const config = parseDaemonConfig({});

    // Act
    const rendered = renderConfiguration(
      describeConfiguration({
        document: {},
        config,
        overrides: {},
        configFile: CONFIG_FILE,
        stateHome,
        stateHomeFromEnvironment: true,
      }),
      config,
      CONFIG_FILE,
    );

    // Assert — one long path must not push every origin off the right of the screen; the origin
    // column is the whole point of the report.
    const hostLine = rendered.split('\n').find(line => line.startsWith('host')) ?? '';
    should(hostLine.length).be.below(90);
    should(hostLine).endWith('(default)');
    // No divergence here, so nothing is warned about.
    should(rendered).not.match(/but advertises/u);
  });
});

describe('the grant posture a `--check` reports', () => {
  const posture = (document: Record<string, unknown>, passwordSet = false) =>
    describeGrantPosture({ config: parseDaemonConfig(document), passwordSet, clientName: 'fy' }).join('\n');

  it('should say nothing can reach it, rather than reciting grants that govern nobody', () => {
    // A daemon bound to loopback with no relay is reachable only by callers this layer does not
    // govern. Reciting five capabilities there would be noise dressed as security, and worse, it
    // would imply a boundary that is not doing anything.
    // Act
    const said = posture({});

    // Assert
    should(said).match(/nothing off this host can reach this daemon \(host 127\.0\.0\.1, no relay\)/u);
    should(said).not.match(/may use/u);
  });

  it('should treat a configured relay as reachable even on a loopback bind', () => {
    // THE ONE PEOPLE FORGET. The daemon DIALS OUT to a rendezvous, so a loopback bind is reachable
    // from anywhere the moment a relay is enabled. A posture reading only `host` would tell somebody
    // running the hosted relay that nothing could reach them.
    // Act
    const said = posture({ relay: { url: 'wss://relay.example.com' } });

    // Assert
    should(said).match(/reachable off this host \(the relay at wss:\/\/relay\.example\.com\)/u);
  });

  it('should not call a disabled relay a way in', () => {
    // A configured address the operator switched off stays readable rather than having to be deleted,
    // so its presence is not reachability.
    // Act
    const said = posture({ relay: { url: 'wss://relay.example.com', enabled: false } });

    // Assert
    should(said).match(/nothing off this host can reach this daemon/u);
  });

  /**
   * Every capability at one setting.
   *
   * DERIVED FROM THE CONTRACT rather than spelled out, so a case says what it means — "all of them",
   * "none of them" — and a sixth capability cannot make it quietly assert something else. A literal
   * list here would have to be edited by whoever adds one, and the failure would look like their bug.
   */
  const every = (value: boolean) =>
    Object.fromEntries(DAEMON_CAPABILITIES.map(name => [name, { use: value, configure: value }]));

  it('should name each capability when only some are granted, and say everything when all are', () => {
    // Act — the partial case names its own exclusions rather than relying on the defaults, which an
    // added capability is free to choose differently.
    const partial = posture({
      host: '0.0.0.0',
      grants: { ...every(true), terminal: { use: false, configure: true }, warden: { use: true, configure: false } },
    });
    const all = posture({ host: '0.0.0.0', grants: every(true) });

    // Assert — each list is read out of the sentence rather than matched loosely, because the two
    // lists differ and a substring test passes on the WRONG one: `terminal` is absent from the use
    // list and present in the configure list, so `not.match(/terminal/)` would fail on a correct
    // sentence and `match(/terminal/)` would pass on a broken one.
    const lists = /may use (.*), and change settings for (.*)$/u.exec(partial.split('\n')[0] ?? '');
    should(lists?.[1]).equal('fleet, browser, filesystem, warden, pairing');
    should(lists?.[2]).equal('fleet, terminal, browser, filesystem, pairing');
    should(all).match(/may use everything, and change settings for everything/u);
  });

  it('should say `nothing` rather than an empty list when every axis is off', () => {
    // Act
    const said = posture({ host: '0.0.0.0', grants: every(false) });

    // Assert
    should(said).match(/may use nothing, and change settings for nothing/u);
  });

  it('should disclose an absent password once, with the command that sets one', () => {
    // The owner's standing complaint is that this product knows something and does not say it. The
    // cost of permissive defaults is real, so it is named — once, and with the next step attached.
    // Act
    const without = posture({ host: '0.0.0.0' });
    const with_ = posture({ host: '0.0.0.0' }, true);

    // Assert
    should(without.match(/any paired device/gu)).have.length(1);
    should(without).match(/fy daemon password set/u);
    should(with_).match(/an operator password gates every one of those changes/u);
    should(with_).not.match(/any paired device/u);
  });

  it('should not disclose a missing password on a machine nothing can reach', () => {
    // There is nothing to disclose: no caller this layer governs can reach the daemon at all, and a
    // warning that does not apply is how people learn to stop reading them.
    // Act
    const said = posture({});

    // Assert
    should(said).not.match(/any paired device/u);
  });

  it.each(['127.0.0.1', '::1', 'localhost', '[::1]'])('should read %s as this machine only', host => {
    // Act + Assert
    should(reachableOffHost(parseDaemonConfig({ host })).reachable).be.false();
  });

  it.each(['0.0.0.0', '192.168.1.10', 'daemon.example.com'])('should read %s as reachable', host => {
    // A LAN address, a public one and the wildcard all accept connections from off this host.
    // Act + Assert
    should(reachableOffHost(parseDaemonConfig({ host })).reachable).be.true();
  });

  it('should count a DISCOVERED relay as a way in, not only a configured one', () => {
    // Arrange: the state every fresh install is in — loopback bind, no `relay` block, and a carrier
    // that came from the advertisement rather than from the document.
    const config = parseDaemonConfig({ host: '127.0.0.1' });
    const discovered = chooseRelayCarrierSource(undefined, { kind: 'available', relayUrl: 'https://relay.example' });

    // Act
    const reach = reachableOffHost(config, discovered);

    // Assert — reading the document alone would tell somebody carried by the hosted relay that
    // nothing on earth could reach them, and would suppress every grant line on that basis.
    should(reach).deepEqual({ reachable: true, how: 'the relay at https://relay.example' });
    should(describeGrantPosture({ config, passwordSet: true, clientName: 'fy', carrier: discovered }).join('\n')).match(
      /reachable off this host \(the relay at https:\/\/relay\.example\)/u,
    );
  });

  it('should still say nothing can reach it when the resolved carrier dials nowhere', () => {
    // Arrange: a resolved answer of "direct-only" is evidence, not silence — so it is honoured
    // rather than falling back to re-reading the document.
    const config = parseDaemonConfig({ host: '127.0.0.1' });
    const none = chooseRelayCarrierSource(undefined, { kind: 'disabled' });

    // Act + Assert
    should(reachableOffHost(config, none).reachable).be.false();
  });
});
