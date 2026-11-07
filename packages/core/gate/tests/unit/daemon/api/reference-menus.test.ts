import { describe, expect, test } from 'bun:test';
import { cap, DEFAULT_GATE_CONFIG, DEFAULT_GATE_SECURITY, FULL_DEVICE_GRANTS } from '../../../../contract/index.ts';
import { ADMIN, admit, declaredRoute, local, world } from '../support.ts';

const MENUS = 'GET /v1/ferrets/:ferretId/references';
const without = (name: 'filesystem' | 'terminal' | 'browser' | 'fleet') => ({
  ...FULL_DEVICE_GRANTS,
  [name]: { use: false, configure: false },
});

/**
 * Conversation's reference menus list files, terminals, pages and cards through ONE route. The route is ungoverned itself and
 * `consultsGrants`, so Gate hands its handler the caller's governance; the handler asks each provider's demand. These
 * rows prove the real admission does that for the route exactly as Conversation's manifest declares it.
 */
describe('the composer reference menus keep the grants of the facts they list', () => {
  test('the declared route consults grants and names no capability of its own', async () => {
    const route = await declaredRoute(MENUS);
    expect(route.consultsGrants).toBe(true);
    expect(route.capability).toBeUndefined();
  });

  test('a device without filesystem use is handed a governance that refuses it, and one that has it is not refused', async () => {
    const route = await declaredRoute(MENUS);
    const w = world();
    w.enrol('no-files', without('filesystem'));
    w.enrol('full');
    const refused = admit(w, route, { device: 'no-files' }).decision;
    if (refused.outcome !== 'admitted') throw new Error('the route itself admits a paired device');
    expect(refused.standing.governance?.governed).toBe(true);
    expect(refused.standing.governance?.decide(cap('filesystem', 'use'))).toMatchObject({
      allowed: false,
      refusal: 'device-not-granted',
    });
    const granted = admit(w, route, { device: 'full' }).decision;
    if (granted.outcome !== 'admitted') throw new Error('expected admitted');
    expect(granted.standing.governance?.decide(cap('filesystem', 'use')).allowed).toBe(true);
  });

  test('a device without terminal use, or without browser use, is refused that list', async () => {
    const route = await declaredRoute(MENUS);
    const w = world();
    w.enrol('no-terminal', without('terminal'));
    w.enrol('no-browser', without('browser'));
    const terminal = admit(w, route, { device: 'no-terminal' }).decision;
    const browser = admit(w, route, { device: 'no-browser' }).decision;
    if (terminal.outcome !== 'admitted' || browser.outcome !== 'admitted') throw new Error('expected admitted');
    expect(terminal.standing.governance?.decide(cap('terminal', 'use')).allowed).toBe(false);
    expect(terminal.standing.governance?.decide(cap('browser', 'use')).allowed).toBe(true);
    expect(browser.standing.governance?.decide(cap('browser', 'use')).allowed).toBe(false);
  });

  test('a device without fleet use is refused the cards list, and one that has it is not', async () => {
    const route = await declaredRoute(MENUS);
    const w = world();
    w.enrol('no-fleet', without('fleet'));
    w.enrol('full');
    const refused = admit(w, route, { device: 'no-fleet' }).decision;
    const granted = admit(w, route, { device: 'full' }).decision;
    if (refused.outcome !== 'admitted' || granted.outcome !== 'admitted') throw new Error('expected admitted');
    expect(refused.standing.governance?.decide(cap('fleet', 'use'))).toMatchObject({
      allowed: false,
      refusal: 'device-not-granted',
    });
    expect(refused.standing.governance?.decide(cap('filesystem', 'use')).allowed).toBe(true);
    expect(granted.standing.governance?.decide(cap('fleet', 'use')).allowed).toBe(true);
  });

  test('the daemon-wide document refuses too, and a step-up the machine asks for is the refusal named', async () => {
    const route = await declaredRoute(MENUS);
    const off = {
      ...DEFAULT_GATE_CONFIG,
      grants: { ...FULL_DEVICE_GRANTS, filesystem: { use: false, configure: false } },
    };
    const wide = world({ policy: off });
    wide.enrol('phone');
    const a = admit(wide, route, { device: 'phone' }).decision;
    if (a.outcome !== 'admitted') throw new Error('expected admitted');
    expect(a.standing.governance?.decide(cap('filesystem', 'use'))).toMatchObject({
      allowed: false,
      refusal: 'not-granted',
    });
    const perAct = world({
      policy: { ...DEFAULT_GATE_CONFIG, security: { ...DEFAULT_GATE_SECURITY, stepUpOnActions: true } },
    });
    perAct.enrol('phone');
    const b = admit(perAct, route, { device: 'phone' }).decision;
    if (b.outcome !== 'admitted') throw new Error('expected admitted');
    expect(b.standing.governance?.decide(cap('terminal', 'use'))).toMatchObject({
      allowed: false,
      refusal: 'step-up-required',
    });
  });

  test('the owner at the machine is ungoverned and is offered every list', async () => {
    const route = await declaredRoute(MENUS);
    const w = world({
      policy: {
        ...DEFAULT_GATE_CONFIG,
        grants: { ...FULL_DEVICE_GRANTS, filesystem: { use: false, configure: false } },
      },
    });
    const owner = admit(w, route, { bearer: ADMIN, arrival: local() }).decision;
    if (owner.outcome !== 'admitted') throw new Error('expected admitted');
    expect(owner.standing.governance?.governed).toBe(false);
    for (const name of ['filesystem', 'terminal', 'browser'] as const)
      expect(owner.standing.governance?.decide(cap(name, 'use')).allowed).toBe(true);
  });
});
