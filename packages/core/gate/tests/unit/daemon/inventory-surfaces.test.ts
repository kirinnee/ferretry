import { describe, expect, test } from 'bun:test';
import type { InventoryEntry, InventorySurfaces } from '@ferretry/kernel/contract';
import { CAPABILITIES, LIMITED_DEVICE_GRANTS } from '../../../contract/index.ts';
import { ADMIN, FERRET_TOKEN, WARDEN, carried, local, request, world } from './support.ts';

/**
 * `GET /v1/plugins` as Gate projects it for each caller (§9.6), through `Admission.inventory` with the surfaces the
 * kernel read from the manifests. Without the surfaces every paired device saw only the core pieces and Access.
 */
const entries: readonly InventoryEntry[] = [
  'kernel',
  'gate',
  'vault',
  'ferrets',
  'asks',
  'access',
  'terminals',
  'board',
  'updates',
  'voice',
].map(id => ({ id, on: id !== 'voice', contract: `h-${id}` }));

const surface = (fields: Record<string, unknown>) =>
  ({ minimum: 'operator', caller: 'any', audit: { skip: 'x' }, guard: { none: 'x' }, ...fields }) as never;

const surfaces: InventorySurfaces = new Map([
  ['terminals', [surface({ capability: { capability: CAPABILITIES.terminal, axis: 'use' } })]],
  ['board', [surface({ capability: { capability: CAPABILITIES.fleet, axis: 'use' } })]],
  ['updates', [surface({ minimum: 'admin-token', caller: 'person' })]],
  ['voice', [surface({ capability: { capability: CAPABILITIES.fleet, axis: 'use' } })]],
]);

const ids = (shown: readonly InventoryEntry[]) => shown.map(entry => entry.id);

describe('§9.6 the device inventory is projected through the plugins’ declared surfaces', () => {
  test('a full device sees every plugin one of its grants admits, not just the core pieces and Access', () => {
    const w = world();
    w.enrol('phone');
    const shown = w.gate.inventory(request({ device: 'phone' }), entries, surfaces);
    expect(ids(shown)).toEqual(['kernel', 'gate', 'vault', 'ferrets', 'asks', 'access', 'terminals', 'board', 'voice']);
  });

  test('an off plugin is still listed with on: false, as the kernel reported it', () => {
    const w = world();
    w.enrol('phone');
    const voice = w.gate.inventory(request({ device: 'phone' }), entries, surfaces).find(entry => entry.id === 'voice');
    expect(voice?.on).toBe(false);
  });

  test('a limited device (fleet use only) sees the core pieces, Access and only the plugins its grant reaches', () => {
    const w = world();
    w.enrol('limited', LIMITED_DEVICE_GRANTS);
    const shown = w.gate.inventory(request({ device: 'limited' }), entries, surfaces);
    expect(ids(shown)).toEqual(['kernel', 'gate', 'vault', 'ferrets', 'asks', 'access', 'board', 'voice']);
    expect(ids(shown)).not.toContain('terminals');
  });

  test('an admin-token-only plugin is never shown to a device', () => {
    const w = world();
    w.enrol('phone');
    expect(ids(w.gate.inventory(request({ device: 'phone' }), entries, surfaces))).not.toContain('updates');
  });

  test('with no surfaces a device sees only the core pieces and Access (the bug this guards)', () => {
    const w = world();
    w.enrol('phone');
    expect(ids(w.gate.inventory(request({ device: 'phone' }), entries, new Map()))).toEqual([
      'kernel',
      'gate',
      'vault',
      'ferrets',
      'asks',
      'access',
    ]);
  });

  test('a refused caller (no principal, no bearer) sees nothing', () => {
    const w = world();
    expect(w.gate.inventory(request({ arrival: carried() }), entries, surfaces)).toEqual([]);
  });

  test('the admin token off the host is governed by the daemon-wide grants, not shown everything', () => {
    const w = world();
    const shown = ids(w.gate.inventory(request({ bearer: ADMIN, arrival: carried() }), entries, surfaces));
    expect(shown).not.toContain('updates');
    expect(shown).toContain('board');
  });

  test('a warden token sees the core pieces and Warden only; a member principal sees nothing', () => {
    const w = world();
    const withWarden = [...entries, { id: 'warden', on: true, contract: 'h-warden' }];
    expect(ids(w.gate.inventory(request({ bearer: WARDEN, arrival: local(true) }), withWarden, surfaces))).toEqual([
      'kernel',
      'gate',
      'vault',
      'ferrets',
      'asks',
      'warden',
    ]);
    expect(w.gate.inventory(request({ member: 'friend' }), entries, surfaces)).toEqual([]);
  });

  test('the owner on the host and a ferret see every package', () => {
    const w = world();
    expect(w.gate.inventory(request({ bearer: ADMIN, arrival: local(true) }), entries, surfaces)).toHaveLength(
      entries.length,
    );
    expect(w.gate.inventory(request({ bearer: FERRET_TOKEN, arrival: local(true) }), entries, surfaces)).toHaveLength(
      entries.length,
    );
  });
});
