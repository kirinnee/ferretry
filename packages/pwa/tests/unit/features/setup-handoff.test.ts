/**
 * Carrying a half-finished setup to the other device.
 *
 * Three things have to be true and none of them is obvious. The payload must carry
 * NOTHING identifying — a hand-off link is meant to be photographed, so a daemon
 * address or a code in it would be a code on somebody's camera roll. A link
 * proposing something the receiving HARDWARE forbids must lose to the hardware
 * rather than send a mid-setup reader back to the beginning. And a link that does
 * not say enough must ASK, because inventing an answer to "which computer runs the
 * daemon" is inventing the one fact this whole flow exists to establish.
 */

import { describe, expect, it } from 'bun:test';

import {
  encodeSetupHandoff,
  landSetupHandoff,
  parseSetupHandoff,
  qrModules,
  SETUP_HANDOFF_KEY,
  setupHandoffFromHref,
  setupHandoffUrl,
  setupPageUrl,
} from '../../../src/features/onboarding/setup-handoff.ts';

const HREF = 'https://ferretry.example.invalid/app/sessions?tab=2#leftover';

describe('the hand-off payload', () => {
  it('is legible rather than a base64 blob', () => {
    // It is read aloud, typed by hand and printed inside a QR whose size grows
    // with every character. A reader can see it says `first-time`, `this`, `self`
    // and nothing else.
    expect(encodeSetupHandoff({ route: 'add-client', step: 'pair' })).toBe('v2;route=add-client;step=pair');
    expect(encodeSetupHandoff({ route: 'first-time', target: 'this', doer: 'self', step: 'install' })).toBe(
      'v2;route=first-time;target=this;doer=self;step=install',
    );
    expect(
      encodeSetupHandoff({
        route: 'first-time',
        target: 'this',
        doer: 'self',
        step: 'relay-source',
        connection: 'own-relay',
      }),
    ).toBe('v2;route=first-time;target=this;doer=self;step=relay-source;connection=own-relay');
  });

  it('round-trips exactly what it was given', () => {
    for (const handoff of [
      { route: 'add-client', step: 'pair' },
      { route: 'add-daemon', target: 'this', doer: 'self', step: 'install' },
      { route: 'first-time', target: 'other', doer: 'agent', step: 'brief' },
      { route: 'first-time', target: 'this', doer: 'self', step: 'relay-allow', connection: 'own-relay' },
    ] as const) {
      expect(parseSetupHandoff(encodeSetupHandoff(handoff))).toEqual(handoff);
    }
  });

  it('refuses rather than repairs', () => {
    // A link whose step is not a step is not a hand-off with a typo in it; it is
    // something else, and guessing what its author meant would land a reader in a
    // journey nobody chose.
    for (const raw of [
      null,
      undefined,
      '',
      'route=first-time;step=install',
      // The positional `v1` grammar: a route plus a step no longer says what
      // journey somebody meant, and `install` belongs to exactly one of them.
      'v1;first-time;install',
      'v3;route=first-time;step=install',
      'v2;route=stepper;step=install',
      'v2;route=first-time;step=billing',
      'v2;step=install',
      'v2;route=first-time',
      'v2;route=first-time;target=cloud;doer=self;step=install',
      'v2;route=first-time;target=this;doer=nobody;step=install',
      'v2;route=first-time;target=this;doer=self;step=install;connection=tunnel',
      // Fields that could not matter on the journey they are attached to, which
      // means this payload was not produced by this page.
      'v2;route=add-client;target=this;step=pair',
      'v2;route=add-client;doer=self;step=pair',
      'v2;route=add-client;step=pair;connection=direct',
      'v2;route=first-time;target=other;doer=self;step=elsewhere;connection=direct',
      // Unknown keys, bare tokens and duplicates.
      'v2;route=first-time;target=this;doer=self;step=install;theme=dark',
      'v2;route=first-time;install',
      'v2;route=first-time;route=add-client;step=pair',
      // The routes this replaced, which describe journeys that no longer exist.
      'v2;route=have-link;step=scan',
      'v2;route=agent;step=brief',
    ]) {
      expect(parseSetupHandoff(raw)).toBeUndefined();
    }
  });
});

describe('the hand-off link', () => {
  it('is built from this page own address, never a compiled one', () => {
    // The origin is a deployment fact: there is no hosted address in this bundle
    // and anyone may deploy it themselves. The query and fragment that brought
    // this reader here are dropped — they are not what the other device replays.
    expect(setupHandoffUrl(HREF, { route: 'add-client', step: 'pair' })).toBe(
      'https://ferretry.example.invalid/setup#fy-setup=v2;route=add-client;step=pair',
    );
    expect(setupPageUrl(HREF)).toBe('https://ferretry.example.invalid/setup');
    expect(SETUP_HANDOFF_KEY).toBe('fy-setup');
  });

  it('carries nothing that identifies a user or a daemon', () => {
    // The whole point of a link somebody is invited to photograph.
    const url = setupHandoffUrl('https://studio.example.invalid/setup?token=secret#v1;daemon;code', {
      route: 'first-time',
      step: 'install',
    });
    for (const leak of ['token', 'secret', 'daemon', 'code']) expect(url).not.toContain(leak);
  });

  it('is read back out of a fragment, and never confused with a pairing one', () => {
    expect(setupHandoffFromHref('https://x.invalid/setup#fy-setup=v2;route=add-client;step=scan')).toEqual({
      route: 'add-client',
      step: 'scan',
    });
    // A pairing fragment means something entirely different and has no `=` pairs
    // this parser recognises.
    expect(setupHandoffFromHref('https://x.invalid/pair#v1;https://d.invalid;sha256:ab;CODE')).toBeUndefined();
    expect(setupHandoffFromHref('https://x.invalid/setup')).toBeUndefined();
    expect(setupHandoffFromHref('https://x.invalid/setup#fy-setup=v2;route=bogus;step=scan')).toBeUndefined();
    expect(setupHandoffFromHref('not a url at all')).toBeUndefined();
  });
});

describe('landing a hand-off', () => {
  it('keeps the step when the receiving device really has it', () => {
    expect(landSetupHandoff({ route: 'add-client', step: 'pair' }, 'mobile')).toEqual({
      kind: 'walk',
      journey: { route: 'add-client' },
      step: 'pair',
    });
  });

  it('opens the recursion exactly as the sending device meant it', () => {
    expect(landSetupHandoff({ route: 'first-time', target: 'this', doer: 'self', step: 'install' }, 'desktop')).toEqual(
      {
        kind: 'walk',
        journey: { route: 'first-time', target: 'this', doer: 'self' },
        step: 'install',
      },
    );
  });

  it('lets the hardware win over a payload proposing the impossible', () => {
    // A stale or hostile link telling a phone that it runs the daemon. Refusing
    // outright would drop somebody mid-setup back to the beginning over a field
    // they never typed, so the phone keeps its own forced answer instead.
    expect(landSetupHandoff({ route: 'first-time', target: 'this', doer: 'self', step: 'install' }, 'mobile')).toEqual({
      kind: 'walk',
      journey: { route: 'first-time', target: 'other', doer: 'self' },
      step: 'elsewhere',
    });
  });

  it('asks the question the payload left open rather than answering it', () => {
    expect(landSetupHandoff({ route: 'add-daemon', step: 'install' }, 'desktop')).toEqual({
      kind: 'ask',
      question: 'target',
      route: 'add-daemon',
    });
    expect(landSetupHandoff({ route: 'first-time', target: 'other', step: 'elsewhere' }, 'desktop')).toEqual({
      kind: 'ask',
      question: 'doer',
      route: 'first-time',
      target: 'other',
    });
  });

  it('carries a connection answer into the journey it lands on, and only where it fits', () => {
    expect(
      landSetupHandoff(
        { route: 'first-time', target: 'this', doer: 'self', step: 'relay-deploy', connection: 'own-relay' },
        'desktop',
      ),
    ).toEqual({
      kind: 'walk',
      journey: { route: 'first-time', target: 'this', doer: 'self', connection: 'own-relay' },
      step: 'relay-deploy',
    });
    // The same payload read on a phone: the target it proposed is impossible, so
    // the carrier answer it depended on goes with it.
    expect(
      landSetupHandoff(
        { route: 'first-time', target: 'this', doer: 'self', step: 'relay-deploy', connection: 'own-relay' },
        'mobile',
      ),
    ).toEqual({
      kind: 'walk',
      journey: { route: 'first-time', target: 'other', doer: 'self' },
      step: 'elsewhere',
    });
  });
});

describe('the QR modules', () => {
  it('are a square grid with the finder patterns a scanner looks for', () => {
    const modules = qrModules('https://ferretry.example.invalid/setup#fy-setup=v2;route=add-client;step=pair');

    // Square, and a real QR version rather than an empty grid.
    expect(modules.length).toBeGreaterThan(20);
    for (const row of modules) expect(row).toHaveLength(modules.length);

    // The top-left finder pattern: 7×7, a solid ring around a 3×3 core. If this
    // holds, the encoder ran — a hand-rolled grid of noise would not have it.
    const dark = (row: number, column: number): boolean => modules[row]?.[column] === true;
    for (let index = 0; index < 7; index += 1) {
      expect(dark(0, index)).toBe(true);
      expect(dark(6, index)).toBe(true);
      expect(dark(index, 0)).toBe(true);
      expect(dark(index, 6)).toBe(true);
    }
    expect(dark(1, 1)).toBe(false);
    expect(dark(3, 3)).toBe(true);
  });

  it('stays small for a short link and grows for a long one', () => {
    // Version 0 asks the encoder for the smallest version the text fits in, so a
    // short link stays a coarse QR a cheap camera can read.
    const short = qrModules('https://f.invalid/setup');
    const long = qrModules(`https://f.invalid/setup#fy-setup=${'x'.repeat(400)}`);
    expect(long.length).toBeGreaterThan(short.length);
  });
});
