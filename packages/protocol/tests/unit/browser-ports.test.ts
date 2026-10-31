import { describe, it } from 'bun:test';
import should from 'should';
import * as browserPorts from '../../src/lib/browser-ports.ts';
import {
  BROWSER_PER_USER_DEFAULT_BASE,
  BrowserPortsSchema,
  BrowserPortsSettingSchema,
  browserPortsBase,
  LOOPBACK_FIREWALL_MARKER_PATH,
  type LoopbackFirewallMarker,
  LoopbackFirewallMarkerSchema,
  loopbackFirewallEntry,
  parseLoopbackFirewallMarker,
  perUserBrowserPorts,
  readLoopbackFirewallMarker,
  resolveBrowserPorts,
} from '../../src/lib/browser-ports.ts';
import { INSTANT } from '../fixtures.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const EXPLICIT = { cdp: 9222, relay: 9223, vnc: 5901 };

const marker = (base: number, entries: LoopbackFirewallMarker['entries'] = []): LoopbackFirewallMarker => ({
  version: 1,
  appliedAt: INSTANT,
  base,
  entries,
});

const schemaCases: SchemaCase[] = [
  { name: 'three ports', schema: BrowserPortsSchema, value: EXPLICIT },
  { name: 'random', schema: BrowserPortsSettingSchema, value: 'random' },
  { name: 'per-user', schema: BrowserPortsSettingSchema, value: 'per-user' },
  { name: 'explicit', schema: BrowserPortsSettingSchema, value: EXPLICIT },
  {
    name: 'a marker',
    schema: LoopbackFirewallMarkerSchema,
    value: marker(20_000, [{ uid: 1001, ports: [20_004, 20_005, 20_006] }]),
  },
  {
    name: 'a verified marker',
    schema: LoopbackFirewallMarkerSchema,
    value: {
      ...marker(20_000, [{ uid: 1001, ports: [20_004, 20_005, 20_006] }]),
      verifiedAt: INSTANT,
      perUser: { 1001: 'ok', 1002: 'failed', 1003: 'missing' },
    },
  },
];

describe('the browser ports schemas', () => {
  it('should cover every schema the module declares', () => {
    // Assert
    assertCoversEverySchema(browserPorts, schemaCases);
  });

  it('should round-trip every accepted shape', () => {
    // Assert
    assertRoundTrips(schemaCases);
  });

  it('should refuse ports out of range, repeated, missing, extra, or a word it does not know', () => {
    // Assert
    assertRejects([
      { name: 'below the range', schema: BrowserPortsSettingSchema, value: { ...EXPLICIT, cdp: 1023 } },
      { name: 'above the range', schema: BrowserPortsSettingSchema, value: { ...EXPLICIT, vnc: 65_536 } },
      { name: 'a fraction', schema: BrowserPortsSettingSchema, value: { ...EXPLICIT, relay: 9223.5 } },
      { name: 'cdp = relay', schema: BrowserPortsSettingSchema, value: { ...EXPLICIT, relay: 9222 } },
      { name: 'relay = vnc', schema: BrowserPortsSettingSchema, value: { ...EXPLICIT, vnc: 9223 } },
      { name: 'cdp = vnc', schema: BrowserPortsSettingSchema, value: { ...EXPLICIT, vnc: 9222 } },
      { name: 'one missing', schema: BrowserPortsSettingSchema, value: { cdp: 9222, relay: 9223 } },
      { name: 'one extra', schema: BrowserPortsSettingSchema, value: { ...EXPLICIT, extra: 1 } },
      { name: 'an unknown word', schema: BrowserPortsSettingSchema, value: 'fixed' },
      {
        name: 'a marker of another version',
        schema: LoopbackFirewallMarkerSchema,
        value: { ...marker(20_000), version: 2 },
      },
      {
        name: 'a marker with a stray key',
        schema: LoopbackFirewallMarkerSchema,
        value: { ...marker(20_000), note: 'x' },
      },
      {
        name: 'a marker with a perUser state it does not know',
        schema: LoopbackFirewallMarkerSchema,
        value: { ...marker(20_000), perUser: { 1001: 'unknown' } },
      },
      {
        name: 'a marker with a verifiedAt that is not an instant',
        schema: LoopbackFirewallMarkerSchema,
        value: { ...marker(20_000), verifiedAt: 'yesterday' },
      },
      { name: 'a marker base below 1024', schema: LoopbackFirewallMarkerSchema, value: marker(1_023) },
      {
        name: 'a marker entry with two ports',
        schema: LoopbackFirewallMarkerSchema,
        value: marker(20_000, [{ uid: 1001, ports: [20_004, 20_005] } as never]),
      },
    ]);
  });
});

describe('perUserBrowserPorts', () => {
  it('should give uid 1000 the base itself and each next uid the next four ports', () => {
    // Act
    const first = perUserBrowserPorts(1000);
    const second = perUserBrowserPorts(1001);

    // Assert
    should(first).deepEqual({ ok: true, ports: { cdp: 20_000, relay: 20_001, vnc: 20_002 } });
    should(second).deepEqual({ ok: true, ports: { cdp: 20_004, relay: 20_005, vnc: 20_006 } });
  });

  it('should move every uid with the base', () => {
    // Act
    const actual = perUserBrowserPorts(1002, 30_000);

    // Assert
    should(actual).deepEqual({ ok: true, ports: { cdp: 30_008, relay: 30_009, vnc: 30_010 } });
  });

  it('should default the base to 20000', () => {
    // Assert
    should(perUserBrowserPorts(1000)).deepEqual(perUserBrowserPorts(1000, BROWSER_PER_USER_DEFAULT_BASE));
    should(BROWSER_PER_USER_DEFAULT_BASE).equal(20_000);
  });

  it('should accept ports that end exactly on 32767', () => {
    // Act
    const actual = perUserBrowserPorts(1000, 32_765);

    // Assert
    should(actual).deepEqual({ ok: true, ports: { cdp: 32_765, relay: 32_766, vnc: 32_767 } });
  });

  it('should refuse a port past 32767, with the sentence that names the way out', () => {
    // Act
    const past = perUserBrowserPorts(1000, 32_766);
    const farUid = perUserBrowserPorts(5_000);

    // Assert
    should(past).deepEqual({
      ok: false,
      reason: 'uid 1000 gets ports outside 1024–32767 from base 32766; set explicit browserPorts or another base',
    });
    should(farUid.ok).be.false();
  });

  it('should refuse a system uid, a base below 1024, and numbers that are not whole', () => {
    // Act
    const system = perUserBrowserPorts(999);
    const lowBase = perUserBrowserPorts(1000, 1_023);
    const fractionalUid = perUserBrowserPorts(1000.5);
    const fractionalBase = perUserBrowserPorts(1000, 20_000.5);

    // Assert
    should(system).deepEqual({
      ok: false,
      reason: 'uid 999 gets ports outside 1024–32767 from base 20000; set explicit browserPorts or another base',
    });
    should(lowBase.ok).be.false();
    should(fractionalUid.ok).be.false();
    should(fractionalBase.ok).be.false();
  });

  it('should accept the lowest base a port can have', () => {
    // Act
    const actual = perUserBrowserPorts(1000, 1_024);

    // Assert
    should(actual).deepEqual({ ok: true, ports: { cdp: 1_024, relay: 1_025, vnc: 1_026 } });
  });
});

describe('the loopback firewall marker', () => {
  it('should read the one the root script wrote', () => {
    // Arrange
    const written = marker(25_000, [{ uid: 1001, ports: [25_004, 25_005, 25_006] }]);

    // Act
    const actual = parseLoopbackFirewallMarker(JSON.stringify(written));

    // Assert
    should(actual).deepEqual(written);
  });

  it('should treat text that is not a marker as no marker', () => {
    // Assert
    should(parseLoopbackFirewallMarker('not json')).be.undefined();
    should(parseLoopbackFirewallMarker('{"version":2}')).be.undefined();
  });

  it('should read it from the default path through the port it is handed', async () => {
    // Arrange
    const paths: string[] = [];
    const written = marker(20_000);

    // Act
    const actual = await readLoopbackFirewallMarker(async path => {
      paths.push(path);
      return JSON.stringify(written);
    });

    // Assert
    should(actual).deepEqual(written);
    should(paths).deepEqual([LOOPBACK_FIREWALL_MARKER_PATH]);
    should(LOOPBACK_FIREWALL_MARKER_PATH).equal('/run/ferretry/loopback-firewall.json');
  });

  it('should read it from another path when one is named', async () => {
    // Arrange
    const paths: string[] = [];

    // Act
    await readLoopbackFirewallMarker(async path => {
      paths.push(path);
      return undefined;
    }, '/tmp/elsewhere.json');

    // Assert
    should(paths).deepEqual(['/tmp/elsewhere.json']);
  });

  it('should find none when there is no file or the read fails', async () => {
    // Act
    const absent = await readLoopbackFirewallMarker(async () => undefined);
    const failed = await readLoopbackFirewallMarker(async () => {
      throw new Error('ENOENT');
    });

    // Assert
    should(absent).be.undefined();
    should(failed).be.undefined();
  });

  it('should derive from the marker base when there is one, else from 20000', () => {
    // Assert
    should(browserPortsBase(marker(30_000))).equal(30_000);
    should(browserPortsBase(undefined)).equal(20_000);
  });
});

describe('resolveBrowserPorts', () => {
  it('should ask for nothing fixed when the setting is random', () => {
    // Assert
    should(resolveBrowserPorts('random', 1001, undefined)).deepEqual({ kind: 'random' });
  });

  it('should hand back explicit ports as they are written', () => {
    // Assert
    should(resolveBrowserPorts(EXPLICIT, 1001, undefined)).deepEqual({ kind: 'fixed', ports: EXPLICIT });
  });

  it('should derive per-user ports from the default base without a marker', () => {
    // Assert
    should(resolveBrowserPorts('per-user', 1001, undefined)).deepEqual({
      kind: 'fixed',
      ports: { cdp: 20_004, relay: 20_005, vnc: 20_006 },
    });
  });

  it('should derive per-user ports from the base an admin moved', () => {
    // Assert
    should(resolveBrowserPorts('per-user', 1001, marker(30_000))).deepEqual({
      kind: 'fixed',
      ports: { cdp: 30_004, relay: 30_005, vnc: 30_006 },
    });
  });

  it('should refuse, in a sentence, a uid per-user cannot serve', () => {
    // Assert
    should(resolveBrowserPorts('per-user', 0, undefined)).deepEqual({
      kind: 'refused',
      reason: 'uid 0 gets ports outside 1024–32767 from base 20000; set explicit browserPorts or another base',
    });
  });
});

describe('loopbackFirewallEntry', () => {
  it('should print `user <uid>` for per-user ports', () => {
    // Assert
    should(loopbackFirewallEntry('per-user', 1001, undefined)).deepEqual({ ok: true, line: 'user 1001' });
  });

  it('should print the explicit line for explicit ports', () => {
    // Assert
    should(loopbackFirewallEntry(EXPLICIT, 1001, undefined)).deepEqual({
      ok: true,
      line: 'user 1001 9222 9223 5901',
    });
  });

  it('should say to set browserPorts first when the setting is random', () => {
    // Act
    const actual = loopbackFirewallEntry('random', 1001, undefined);

    // Assert
    should(actual).deepEqual({
      ok: false,
      reason: 'browserPorts is random, so there is no firewall entry: set browserPorts first',
    });
  });

  it('should refuse a uid below 1000, which the firewall file does not accept', () => {
    // Act
    const perUser = loopbackFirewallEntry('per-user', 999, undefined);
    const explicit = loopbackFirewallEntry(EXPLICIT, 0, undefined);

    // Assert
    should(perUser).deepEqual({
      ok: false,
      reason: 'uid 999 is below 1000, which the loopback firewall does not accept; run as an ordinary user',
    });
    should(explicit.ok).be.false();
  });

  it('should refuse per-user when the derivation runs out of ports', () => {
    // Act
    const actual = loopbackFirewallEntry('per-user', 1000, marker(32_766));

    // Assert
    should(actual).deepEqual({
      ok: false,
      reason: 'uid 1000 gets ports outside 1024–32767 from base 32766; set explicit browserPorts or another base',
    });
  });
});
