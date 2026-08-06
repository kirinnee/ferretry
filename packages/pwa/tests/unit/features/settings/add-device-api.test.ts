import { describe, it } from 'bun:test';
import type { PairedDevicesView, PairingCodeMintResponse, PairingId } from '@ferretry/protocol';
import should from 'should';
import {
  mintPairingCode,
  PAIRED_DEVICES_PATH,
  PAIRING_CODE_PATH,
  type PairingClient,
  pairingFailure,
  readPairedDevices,
  revokePairedDevice,
  revokePairingCode,
} from '../../../../src/features/settings/add-device-api.ts';

const DAEMON_ID = `fy_daemon_${'a'.repeat(43)}`;
const PAIRING_ID = `fy_pair_${'b'.repeat(22)}` as PairingId;
const DEVICE_ID = `fy_device_id_${'c'.repeat(22)}`;

const minted: PairingCodeMintResponse = {
  pairingId: PAIRING_ID,
  code: '7F3K-Q2ND',
  ttlSeconds: 120,
  expiresAt: '2026-08-03T12:02:00.000Z',
  daemonId: DAEMON_ID,
  daemonName: 'workstation',
  daemonUrl: 'https://workstation.example.test',
  pairUrl: `https://ferretry.pages.dev/pair#v1;url=https%3A%2F%2Fworkstation.example.test;code=7F3K-Q2ND;fp=${DAEMON_ID}`,
  reach: 'any-device',
};

const devices: PairedDevicesView = {
  devices: [
    {
      id: DEVICE_ID,
      name: 'Pixel 8',
      platform: 'browser',
      createdAt: '2026-08-01T09:00:00.000Z',
      lastSeenAt: '2026-08-03T11:00:00.000Z',
    },
  ],
  hostLocal: true,
  thisDeviceId: DEVICE_ID,
};

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

/** A client that records what was asked of it and answers with whatever the test supplies. */
function recording(answer: unknown): { readonly client: PairingClient; readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      request: async (path, schema, init) => {
        calls.push({ path, init });
        return schema.parse(answer);
      },
    },
  };
}

describe('the pairing routes', () => {
  it('mints with the bodyless contract the daemon enforces', () => {
    // The redeeming device names ITSELF, so there is nothing for this end to send. The request schema is
    // strict, so a field invented here would be refused rather than ignored.
    // Arrange
    const { client, calls } = recording(minted);

    // Act, Assert
    return mintPairingCode(client).then(response => {
      should(response).deepEqual(minted);
      should(calls).have.length(1);
      should(calls[0]?.path).equal(PAIRING_CODE_PATH);
      should(calls[0]?.init?.method).equal('POST');
      should(calls[0]?.init?.body).equal('{}');
    });
  });

  it('revokes a code by its pairing id, so the code itself never enters a URL', () => {
    // A URL reaches every access log in the path. A revoke keyed by the code would write the code
    // somewhere it outlives its two minutes.
    // Arrange
    const { client, calls } = recording({ pairingId: PAIRING_ID, status: 'expired', expiresAt: minted.expiresAt });

    // Act, Assert
    return revokePairingCode(client, PAIRING_ID).then(status => {
      should(status.status).equal('expired');
      should(calls[0]?.path).equal(`${PAIRING_CODE_PATH}/${PAIRING_ID}`);
      should(calls[0]?.path).not.containEql(minted.code);
      should(calls[0]?.init?.method).equal('DELETE');
    });
  });

  it('reads the device list, and the parsed view carries no digest to leak', async () => {
    // Arrange
    const { client, calls } = recording({
      ...devices,
      devices: [{ ...devices.devices[0], tokenHash: 'h'.repeat(43) }],
    });

    // Act, Assert — the schema is strict, so a daemon that volunteered a digest is refused here rather
    // than rendered. That is the property, and it belongs at the boundary rather than in a renderer.
    await should(readPairedDevices(client)).be.rejected();
    should(calls[0]?.path).equal(PAIRED_DEVICES_PATH);
  });

  it('answers a device revoke with the remaining list rather than a bare acknowledgement', () => {
    // A screen that guessed at the new state is how a revoked device stays visible, or a surviving one
    // disappears.
    // Arrange
    const remaining: PairedDevicesView = { devices: [], hostLocal: true };
    const { client, calls } = recording(remaining);

    // Act, Assert
    return revokePairedDevice(client, DEVICE_ID).then(view => {
      should(view).deepEqual(remaining);
      should(calls[0]?.path).equal(`${PAIRED_DEVICES_PATH}/${DEVICE_ID}`);
      should(calls[0]?.init?.method).equal('DELETE');
    });
  });

  it('reads a failure’s code structurally, so a wrapped error is not downgraded', () => {
    // The daemon distinguishes "the operator said no" from "nothing answered" by code, and the code is
    // read off the value rather than by instance check: a transport wrapper that preserves the field
    // must not be reported as an unknown error.
    // Arrange
    const refusal = Object.assign(new Error('the operator has not granted this'), { code: 'grant_not_granted' });

    // Act, Assert
    should(pairingFailure(refusal)).deepEqual({
      message: 'the operator has not granted this',
      code: 'grant_not_granted',
    });
    should(pairingFailure(new Error('network down'))).deepEqual({ message: 'network down' });
    should(pairingFailure('not an error')).deepEqual({ message: 'not an error' });
    should(pairingFailure(null)).deepEqual({ message: 'null' });
  });
});
