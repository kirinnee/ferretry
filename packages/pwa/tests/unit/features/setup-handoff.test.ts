/**
 * Carrying a half-finished setup to the other device.
 *
 * Two things have to be true and neither is obvious. First, the payload must
 * carry NOTHING identifying — a hand-off link is meant to be photographed, so a
 * daemon address or a code in it would be a code on somebody's camera roll.
 * Second, a link the receiving device cannot act on must land somewhere it can:
 * `install` proposed to a phone is a screen full of commands with nowhere to type
 * them, and the honest landing is that route's own first step.
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
    // with every character. A reader can see it says `first-time` and nothing else.
    expect(encodeSetupHandoff({ route: 'first-time', step: 'install' })).toBe('v1;first-time;install');
    expect(encodeSetupHandoff({ route: 'first-time', step: 'relay-source', connection: 'own-relay' })).toBe(
      'v1;first-time;relay-source;own-relay',
    );
  });

  it('round-trips exactly what it was given', () => {
    for (const handoff of [
      { route: 'add-client', step: 'pair' },
      { route: 'first-time', step: 'relay-allow', connection: 'own-relay' },
    ] as const) {
      expect(parseSetupHandoff(encodeSetupHandoff(handoff))).toEqual(handoff);
    }
  });

  it('refuses rather than repairs', () => {
    // A link whose step is not a step is not a hand-off with a typo in it; it is
    // something else, and guessing which route its author meant would land a
    // reader in a journey nobody chose.
    for (const raw of [
      null,
      undefined,
      '',
      'first-time;install',
      'v2;first-time;install',
      'v1;stepper;install',
      'v1;first-time;billing',
      'v1;first-time;install;tunnel',
      'v1;first-time;install;direct;extra',
      // The routes this replaced, which describe journeys that no longer exist.
      'v1;have-link;scan',
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
      'https://ferretry.example.invalid/setup#fy-setup=v1;add-client;pair',
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
    expect(setupHandoffFromHref('https://x.invalid/setup#fy-setup=v1;add-client;scan')).toEqual({
      route: 'add-client',
      step: 'scan',
    });
    // A pairing fragment means something entirely different and has no `=`.
    expect(setupHandoffFromHref('https://x.invalid/pair#v1;https://d.invalid;sha256:ab;CODE')).toBeUndefined();
    expect(setupHandoffFromHref('https://x.invalid/setup')).toBeUndefined();
    expect(setupHandoffFromHref('https://x.invalid/setup#fy-setup=v1;bogus;scan')).toBeUndefined();
    expect(setupHandoffFromHref('not a url at all')).toBeUndefined();
  });
});

describe('landing a hand-off', () => {
  it('keeps the step when the receiving device really has it', () => {
    expect(landSetupHandoff({ route: 'add-client', step: 'pair' }, 'mobile')).toEqual({
      path: { route: 'add-client', device: 'mobile', connection: undefined },
      step: 'pair',
    });
  });

  it('falls back to the route rather than to a screen the device cannot act on', () => {
    // A stale or hostile link proposing `install` to a phone.
    expect(landSetupHandoff({ route: 'first-time', step: 'install' }, 'mobile')).toEqual({
      path: { route: 'first-time', device: 'mobile', connection: undefined },
      step: 'need-computer',
    });
  });

  it('carries a connection answer into the path it lands on', () => {
    expect(landSetupHandoff({ route: 'first-time', step: 'relay-deploy', connection: 'own-relay' }, 'desktop')).toEqual(
      {
        path: { route: 'first-time', device: 'desktop', connection: 'own-relay' },
        step: 'relay-deploy',
      },
    );
  });
});

describe('the QR modules', () => {
  it('are a square grid with the finder patterns a scanner looks for', () => {
    const modules = qrModules('https://ferretry.example.invalid/setup#fy-setup=v1;add-client;pair');

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
