/**
 * A step-up ends with the page that performed it, decided by the daemon rather than by the page.
 *
 * `appSession` is a value the page picks, so code running in it could keep the value and present it
 * again later. What it cannot keep is a live session, and these cases prove that a step-up belongs to
 * one unbroken span of them.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import { LiveDeviceConnections } from '../../../src/lib/pairing/live-connections.ts';
import { APP_SESSION_GRACE_MS, StepUpRegistry } from '../../../src/lib/step-up/registry.ts';

const PAGE = { deviceId: 'fy_device_id_phone', appSession: 'page-one' } as const;

const registryAt = (start = 1_000) => {
  let now = start;
  const registry = new StepUpRegistry({ nowMs: () => now });
  return {
    registry,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

describe('a step-up and the span of its app session', () => {
  it('holds a step-up while the page has a live session', () => {
    const { registry, now } = registryAt();
    registry.open(PAGE);
    registry.grant(PAGE, now());
    should(registry.held(PAGE, now())).be.true();
  });

  it('holds nothing for a page with no session at all', () => {
    const { registry, now } = registryAt();
    registry.grant(PAGE, now());
    should(registry.held(PAGE, now())).be.false();
  });

  it('keeps the step-up across a reconnect inside the grace', () => {
    const { registry, now, advance } = registryAt();
    const close = registry.open(PAGE);
    registry.grant(PAGE, now());
    close();
    advance(APP_SESSION_GRACE_MS - 1);
    should(registry.held(PAGE, now())).be.true();
    registry.open(PAGE);
    advance(APP_SESSION_GRACE_MS * 2);
    should(registry.held(PAGE, now())).be.true();
  });

  it('ends the step-up once the page has had no session for the grace', () => {
    const { registry, now, advance } = registryAt();
    const close = registry.open(PAGE);
    registry.grant(PAGE, now());
    close();
    advance(APP_SESSION_GRACE_MS);
    should(registry.held(PAGE, now())).be.false();
  });

  it('gives a kept id that is presented again later a clean span that holds nothing', () => {
    // The attack: code in the page kept the id, the page closed, and a later page presents it.
    const { registry, now, advance } = registryAt();
    const close = registry.open(PAGE);
    registry.grant(PAGE, now());
    close();
    advance(APP_SESSION_GRACE_MS);
    registry.open(PAGE);
    should(registry.held(PAGE, now())).be.false();
  });

  it('keeps the span while any of its sessions is open, and counts each close once', () => {
    const { registry, now, advance } = registryAt();
    const first = registry.open(PAGE);
    const second = registry.open(PAGE);
    registry.grant(PAGE, now());
    first();
    first();
    advance(APP_SESSION_GRACE_MS * 2);
    should(registry.held(PAGE, now())).be.true();
    second();
    advance(APP_SESSION_GRACE_MS);
    should(registry.held(PAGE, now())).be.false();
  });

  it('forgets ended spans of other pages as sessions close', () => {
    const { registry, now, advance } = registryAt();
    const other = { ...PAGE, appSession: 'page-two' };
    const closeOther = registry.open(other);
    registry.grant(other, now());
    closeOther();
    advance(APP_SESSION_GRACE_MS);
    // A close elsewhere sweeps the ended span; reopening the id must not find its old step-up.
    registry.open(PAGE)();
    registry.open(other);
    should(registry.held(other, now())).be.false();
  });

  it('is told about app sessions by the connection registry, and only for connections that name one', () => {
    const { registry, now, advance } = registryAt();
    const connections = new LiveDeviceConnections(registry);
    const release = connections.track(PAGE.deviceId, () => undefined, PAGE.appSession);
    registry.grant(PAGE, now());
    should(registry.held(PAGE, now())).be.true();
    connections.track(PAGE.deviceId, () => undefined)();
    release();
    advance(APP_SESSION_GRACE_MS);
    should(registry.held(PAGE, now())).be.false();
  });
});
