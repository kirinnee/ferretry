import { describe, expect, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import { landingAfterPairing } from '../../../../../src/features/fleet/setup/first-run-landing.ts';
import { machineClient, machineView, pairing } from '../shell/machine-support.ts';

const studio = pairing('studio', 'studio mac');


describe('landingAfterPairing', () => {
  it('opens the full-screen first run of a machine that is not set up, outside Settings', async () => {
    const paths: string[] = [];
    const landing = await landingAfterPairing(studio, async () =>
      machineClient(machineView({ setUp: false, runtimeCount: 0 }), paths),
    );
    expect(landing).toBe('/d/studio/setup');
    expect(paths).toEqual(['/v1/fleet/machine']);
  });

  it('goes to the sessions of a machine that is set up', async () => {
    expect(await landingAfterPairing(studio, async () => machineClient(machineView()))).toBe('/d/studio');
  });

  it('fails open to the sessions when the machine could not say', async () => {
    const unnamed = pairing('fresh');
    expect(await landingAfterPairing(unnamed, async () => machineClient(new Error('unreachable')))).toBe('/d/fresh');
    expect(
      await landingAfterPairing(unnamed, async () => machineClient(new FyHttpError('older daemon', 404, 'not_found'))),
    ).toBe('/d/fresh');
  });
});
