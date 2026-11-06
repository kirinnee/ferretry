import { describe, expect, it } from 'bun:test';
import {
  DISCOVERED_RELAY_CARRIER,
  documentWithCarrierEntries,
  isCarrierOfKind,
  legacyBindEntry,
} from '../../../src/lib/runtime/carriers.ts';
import { planCarrierConversion } from '../../../src/lib/runtime/carriers-conversion.ts';
import { parseDaemonConfig } from '../../../src/lib/runtime/config.ts';

function converted(document: unknown) {
  const plan = planCarrierConversion(document);
  if (plan.kind !== 'convert') throw new Error(`expected a conversion, got ${plan.kind}`);
  return plan;
}

/** The two readings of one document, so a test can say the listener and the relays did not move. */
function reading(document: unknown) {
  const config = parseDaemonConfig(document);
  return {
    host: config.host,
    port: config.port,
    portIsRecorded: config.portIsRecorded,
    bindUrl: config.bindUrl,
    publicUrl: config.publicUrl,
    carrierSet: config.carrierSet,
  };
}

describe('converting the legacy listener keys', () => {
  it('should turn a host alone into a bind carrier and write no port', () => {
    const plan = converted({ host: 'box.lan' });

    expect(plan.document).toEqual({ carriers: [{ kind: 'bind', host: 'box.lan' }] });
    expect(plan.removedKeys).toEqual(['host']);
    expect(plan.addedEntries).toEqual([{ kind: 'bind', host: 'box.lan' }]);
    expect(Object.hasOwn((plan.document.carriers as Record<string, unknown>[])[0] ?? {}, 'port')).toBe(false);
  });

  it('should turn a port alone into a loopback bind carrier that keeps the written port', () => {
    const plan = converted({ port: 9_100 });

    expect(plan.document).toEqual({ carriers: [{ kind: 'bind', host: '127.0.0.1', port: 9_100 }] });
    expect(plan.removedKeys).toEqual(['port']);
  });

  it('should keep the host exactly as typed beside the port', () => {
    const plan = converted({ host: '0.0.0.0', port: 7_431 });

    expect(plan.document).toEqual({ carriers: [{ kind: 'bind', host: '0.0.0.0', port: 7_431 }] });
    expect(plan.removedKeys).toEqual(['host', 'port']);
  });

  it('should carry port 0 over, because it is a written decision to let the system choose', () => {
    const plan = converted({ host: '127.0.0.1', port: 0 });

    expect(plan.document).toEqual({ carriers: [{ kind: 'bind', host: '127.0.0.1', port: 0 }] });
    expect(reading(plan.document).portIsRecorded).toBe(false);
  });

  it('should drop host and port when a bind carrier already declares the listener', () => {
    const plan = converted({
      host: '127.0.0.2',
      port: 9_202,
      carriers: [{ kind: 'bind', host: '127.0.0.3', port: 9_203 }],
    });

    expect(plan.document).toEqual({ carriers: [{ kind: 'bind', host: '127.0.0.3', port: 9_203 }] });
    expect(plan.addedEntries).toEqual([]);
    expect(plan.removedKeys).toEqual(['host', 'port']);
  });

  it('should keep the document order, keeping other keys where they were', () => {
    const plan = converted({ healthIntervalSeconds: 90, host: 'box.lan', port: 9_100, projectRoots: ['~/Code'] });

    expect(Object.keys(plan.document)).toEqual(['healthIntervalSeconds', 'carriers', 'projectRoots']);
    expect(plan.document.healthIntervalSeconds).toBe(90);
    expect(plan.document.projectRoots).toEqual(['~/Code']);
  });
});

describe('converting the legacy relay block', () => {
  it.each([
    { name: 'enabled', relay: { url: 'wss://relay.example', enabled: true } },
    { name: 'disabled', relay: { url: 'wss://relay.example', enabled: false } },
    { name: 'a custom reconnect', relay: { url: 'wss://relay.example', reconnectSeconds: 30 } },
    { name: 'no optional field', relay: { url: 'wss://relay.example' } },
  ])('should carry a relay block with $name over exactly as written', ({ relay }) => {
    const plan = converted({ relay });

    expect(plan.document).toEqual({ carriers: [{ kind: 'relay', ...relay }] });
    expect(plan.removedKeys).toEqual(['relay']);
    // Nothing is filled in: a default written out is indistinguishable from a line the operator typed.
    expect(Object.keys((plan.document.carriers as Record<string, unknown>[])[0] ?? {})).toEqual([
      'kind',
      ...Object.keys(relay),
    ]);
    expect(reading({ relay }).carrierSet).toEqual(reading(plan.document).carrierSet);
  });

  it('should drop the relay block when a relay carrier already supersedes it', () => {
    const plan = converted({
      relay: { url: 'wss://legacy.example' },
      carriers: [{ kind: 'relay', url: 'wss://new.example' }],
    });

    expect(plan.document).toEqual({ carriers: [{ kind: 'relay', url: 'wss://new.example' }] });
    expect(plan.addedEntries).toEqual([]);
  });

  it('should add NO relay entry when no relay block was written, because omission already is the hosted relay', () => {
    const original = { host: '127.0.0.1', port: 7_431 };
    const plan = converted(original);

    // The proof, both ways: no relay in carriers and no legacy block resolves to the discovery entry,
    // before the rewrite and after it, so writing a relay entry would be a statement nobody made.
    expect(reading(original).carrierSet.relays).toEqual([DISCOVERED_RELAY_CARRIER]);
    expect(reading(plan.document).carrierSet.relays).toEqual([DISCOVERED_RELAY_CARRIER]);
    expect(plan.addedEntries.some(entry => entry.kind === 'relay')).toBe(false);
  });
});

describe("converting the owner's own document", () => {
  it('should listen on the same address, keep the tunnel and keep the hosted relay', () => {
    const original = { host: '127.0.0.1', port: 7_431, carriers: [{ kind: 'tunnel', source: 'discovery' }] };

    const plan = converted(original);

    expect(plan.document).toEqual({
      carriers: [
        { kind: 'tunnel', source: 'discovery' },
        { kind: 'bind', host: '127.0.0.1', port: 7_431 },
      ],
    });
    const before = reading(original);
    const after = reading(plan.document);
    expect(after).toEqual(before);
    expect(after.bindUrl).toBe('http://127.0.0.1:7431');
    expect(after.carrierSet.tunnel).toEqual({ kind: 'tunnel', source: 'discovery', enabled: true });
    expect(after.carrierSet.relays).toEqual([DISCOVERED_RELAY_CARRIER]);
  });

  it('should keep a tunnel entry and add the bind beside it', () => {
    const plan = converted({ port: 9_300, carriers: [{ kind: 'tunnel', source: 'discovery', enabled: false }] });

    expect(plan.document.carriers).toEqual([
      { kind: 'tunnel', source: 'discovery', enabled: false },
      { kind: 'bind', host: '127.0.0.1', port: 9_300 },
    ]);
  });
});

describe('what is not converted', () => {
  it.each([
    { name: 'an empty document', document: {} },
    { name: 'carriers only', document: { carriers: [{ kind: 'bind', host: 'box.lan', port: 9_100 }] } },
    { name: 'other keys only', document: { healthIntervalSeconds: 90 } },
    { name: 'a value that is not an object', document: 'text' },
    { name: 'null', document: null },
    { name: 'a list', document: [{ host: 'box.lan' }] },
  ])('should report nothing to do for $name', ({ document }) => {
    expect(planCarrierConversion(document)).toEqual({ kind: 'none' });
  });

  it('should be idempotent: the output of a conversion needs none', () => {
    const first = converted({
      host: 'box.lan',
      port: 9_100,
      relay: { url: 'wss://relay.example', enabled: false },
      carriers: [{ kind: 'tunnel', source: 'discovery' }],
    });

    expect(planCarrierConversion(first.document)).toEqual({ kind: 'none' });
  });

  it.each([
    { name: 'carriers that is not a list', document: { host: 'box.lan', carriers: 'nonsense' } },
    { name: 'carriers that is an object', document: { port: 9_100, carriers: { kind: 'bind' } } },
    { name: 'a relay that is not an object', document: { relay: 'wss://relay.example' } },
    { name: 'a relay that is null', document: { relay: null } },
    { name: 'a relay url the schema refuses', document: { relay: { url: 'http://relay.example' } } },
    { name: 'an unknown relay field', document: { relay: { url: 'wss://relay.example', extra: true } } },
    { name: 'a port out of range', document: { port: 70_000 } },
    { name: 'a port that is not a number', document: { port: 'seventy' } },
    { name: 'an empty host', document: { host: '' } },
    { name: 'a host that is not a string', document: { host: 7 } },
    { name: 'a document that does not parse for an unrelated reason', document: { host: 'box.lan', unknown: true } },
    {
      name: 'two bind carriers',
      document: {
        host: 'box.lan',
        carriers: [
          { kind: 'bind', host: 'a.lan' },
          { kind: 'bind', host: 'b.lan' },
        ],
      },
    },
  ])('should refuse $name and write nothing', ({ document }) => {
    const plan = planCarrierConversion(document);

    expect(plan.kind).toBe('refuse');
    expect(plan.kind === 'refuse' && plan.reason.length > 0).toBe(true);
  });

  it('should refuse a rewrite whose reading differs, and say that is why', () => {
    // Forced: the candidate (no legacy keys) is read as a different listener than the original.
    const disagreeing = (document: unknown) => {
      const config = parseDaemonConfig(document);
      return Object.hasOwn(document as object, 'port') ? config : { ...config, port: config.port + 1 };
    };

    const plan = planCarrierConversion({ host: 'box.lan', port: 9_100 }, disagreeing);

    expect(plan.kind).toBe('refuse');
    expect(plan.kind === 'refuse' && plan.reason).toContain('would not read the same');
  });

  it('should refuse when only the derived addresses differ', () => {
    const disagreeing = (document: unknown) => {
      const config = parseDaemonConfig(document);
      return Object.hasOwn(document as object, 'host') ? config : { ...config, publicUrl: 'http://elsewhere:1' };
    };

    expect(planCarrierConversion({ host: 'box.lan' }, disagreeing).kind).toBe('refuse');
  });

  it('should keep a stated public URL reading the same through the rewrite', () => {
    const plan = planCarrierConversion({ host: 'box.lan', port: 9_100, publicUrl: 'https://box.example.test' });

    expect(plan.kind).toBe('convert');
    if (plan.kind === 'convert') expect(reading(plan.document).publicUrl).toBe('https://box.example.test');
  });
});

describe('the document helpers the conversion and the port recorder share', () => {
  it('should create carriers where the first removed key stood and leave other keys alone', () => {
    expect(
      documentWithCarrierEntries({ a: 1, host: 'x', b: 2, port: 3, c: 4 }, ['host', 'port'], [{ kind: 'bind' }]),
    ).toEqual({ a: 1, carriers: [{ kind: 'bind' }], b: 2, c: 4 });
  });

  it('should append to an existing carriers list in place and keep a prototype-looking key an ordinary key', () => {
    const raw = JSON.parse('{"__proto__": {"x": 1}, "carriers": [1], "host": "h"}') as Record<string, unknown>;

    const next = documentWithCarrierEntries(raw, ['host'], [2]);

    expect(Object.keys(next)).toEqual(['__proto__', 'carriers']);
    expect(next.carriers).toEqual([1, 2]);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
  });

  it('should append nothing and create carriers at the end when nothing was removed', () => {
    expect(documentWithCarrierEntries({ a: 1 }, [], [])).toEqual({ a: 1, carriers: [] });
  });

  it('should spell a legacy bind with the written host, loopback when none, and a port only when given', () => {
    expect(legacyBindEntry({ host: 'box.lan' })).toEqual({ kind: 'bind', host: 'box.lan' });
    expect(legacyBindEntry({})).toEqual({ kind: 'bind', host: '127.0.0.1' });
    expect(legacyBindEntry({ host: 'box.lan', port: 1 }, 2)).toEqual({ kind: 'bind', host: 'box.lan', port: 2 });
  });

  it('should recognise an entry of a kind the way the protocol does', () => {
    expect(isCarrierOfKind({ kind: 'bind' }, 'bind')).toBe(true);
    expect(isCarrierOfKind({ kind: 'relay' }, 'bind')).toBe(false);
    expect(isCarrierOfKind(null, 'bind')).toBe(false);
    expect(isCarrierOfKind('bind', 'bind')).toBe(false);
  });
});
