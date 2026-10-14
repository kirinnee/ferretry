import {
  DAEMON_CAPABILITIES,
  type DaemonCapability,
  type DeviceGrantsPatch,
  type PairedDevice,
} from '@ferretry/protocol';
import { FyHttpError, FyTransportError } from '@ferretry/protocol/client';
import type { IDeviceGateway, IDeviceOutput, IDevicePrompt } from './ports.ts';
import {
  renderAmbiguous,
  renderDeviceChange,
  renderDevices,
  renderNoSuchDevice,
  renderRevokeCancelled,
  renderRevokeDeclined,
  renderRevoked,
  renderRevokeGone,
  renderRevokeUnreachable,
} from './render.ts';
import { resolveDevice } from './resolve.ts';

/** What the owner types to confirm a revocation by hand. */
const REVOKE_CONFIRMATION_WORD = 'revoke';
const DEVICE_NOT_FOUND_CODE = 'pairing_device_not_found';

/** Flags the device commands accept. */
export interface DeviceCommandOptions {
  readonly json?: boolean;
  /** `--use` / `--no-use`; absent means "leave this axis alone". */
  readonly use?: boolean;
  /** `--configure` / `--no-configure`; absent means "leave this axis alone". */
  readonly configure?: boolean;
  /** Skip the typed confirmation; required for a revocation off a terminal. */
  readonly yes?: boolean;
}

export interface DeviceControllerDeps {
  readonly gateway: IDeviceGateway;
  readonly out: IDeviceOutput;
  readonly prompt: IDevicePrompt;
  /** Whether both ends of the terminal are a person; off one, a revocation needs `--yes`. */
  readonly interactive: boolean;
  /** The command a human types, so every message names it rather than inventing one. */
  readonly clientName: string;
}

/**
 * Drives `fy device …`.
 *
 * Granting is non-interactive: this command line holds the admin token, so it is ungoverned and needs no
 * confirmation to widen or narrow a device, and a prompt would break an unattended run. REVOKING is the
 * one irreversible change — the device must be paired again — so it asks, unless `--yes` waived it.
 */
export class DeviceController {
  constructor(private readonly deps: DeviceControllerDeps) {}

  async list(options: DeviceCommandOptions): Promise<void> {
    const view = await this.deps.gateway.list();
    if (options.json === true) {
      this.deps.out.success(JSON.stringify(view));
      return;
    }
    this.deps.out.success(renderDevices(view.devices, view.thisDeviceId, this.deps.clientName));
  }

  /**
   * Changes one capability on one device.
   *
   * A change naming neither axis is refused rather than treated as a no-op: answering "done" for a
   * command that did nothing is how a person comes to believe they configured something.
   */
  async grant(deviceQuery: string, capability: string, options: DeviceCommandOptions): Promise<void> {
    const target = DAEMON_CAPABILITIES.find(candidate => candidate === capability);
    if (target === undefined) {
      this.fail(
        `${JSON.stringify(capability)} is not a capability this daemon has; expected one of ${DAEMON_CAPABILITIES.join(', ')}`,
      );
      return;
    }
    if (options.use === undefined && options.configure === undefined) {
      this.fail('nothing to change: name at least one axis, as `--use`/`--no-use` or `--configure`/`--no-configure`');
      return;
    }
    const { devices } = await this.deps.gateway.list();
    const resolution = resolveDevice(devices, deviceQuery);
    if (resolution.kind !== 'found') {
      this.fail(
        describeMismatch(
          deviceQuery,
          resolution.kind === 'ambiguous' ? resolution.candidates : [],
          devices,
          this.deps.clientName,
        ),
      );
      return;
    }
    const { device } = resolution;
    const after = await this.deps.gateway.changeGrants(device.id, patchFor(target, options));
    const updated = after.devices.find(candidate => candidate.id === device.id);
    if (updated === undefined) {
      this.fail(`the daemon no longer lists ${device.id} after the change; it may have been revoked`);
      return;
    }
    this.deps.out.success(renderDeviceChange(updated));
  }

  /**
   * Takes one device's access away, at the machine.
   *
   * ONE SENTENCE IN, ONE SENTENCE OUT, as `fy passkey window` ends: every ending is a single plain
   * sentence and every ending but the revocation exits 1. Refusals are read from the daemon's status
   * and code, never its prose; anything not recognised is rethrown for the composition root to print.
   */
  async revoke(deviceQuery: string, options: DeviceCommandOptions): Promise<void> {
    try {
      const resolution = resolveDevice((await this.deps.gateway.list()).devices, deviceQuery);
      if (resolution.kind === 'none') {
        this.fail(renderNoSuchDevice(deviceQuery, resolution.known, this.deps.clientName));
        return;
      }
      if (resolution.kind === 'ambiguous') {
        this.fail(renderAmbiguous(deviceQuery, resolution.candidates));
        return;
      }
      const { device } = resolution;
      if (options.yes !== true) {
        if (!this.deps.interactive) {
          this.fail(renderRevokeDeclined(device, this.deps.clientName));
          return;
        }
        const answer = await this.deps.prompt.ask(
          `Revoke ${JSON.stringify(device.name)} (${device.id})? It must be paired again to return. Type ${JSON.stringify(REVOKE_CONFIRMATION_WORD)} to confirm:`,
        );
        if (answer.trim() !== REVOKE_CONFIRMATION_WORD) {
          this.fail(renderRevokeCancelled(device));
          return;
        }
      }
      await this.deps.gateway.revoke(device.id);
      this.deps.out.success(renderRevoked(device));
    } catch (error) {
      if (error instanceof FyTransportError) return this.fail(renderRevokeUnreachable(this.deps.clientName));
      if (error instanceof FyHttpError && error.status === 404 && error.code === DEVICE_NOT_FOUND_CODE) {
        return this.fail(renderRevokeGone(this.deps.clientName));
      }
      throw error;
    }
  }

  private fail(message: string): void {
    this.deps.out.error(message);
    this.deps.out.setExitCode(1);
  }
}

function describeMismatch(
  query: string,
  matches: readonly PairedDevice[],
  devices: readonly PairedDevice[],
  clientName: string,
): string {
  if (matches.length > 1)
    return `${JSON.stringify(query)} names ${String(matches.length)} devices; use an id instead: ${matches.map(device => device.id).join(', ')}`;
  return devices.length === 0
    ? `no device is paired with this host, so ${JSON.stringify(query)} matches nothing; pair one with \`${clientName} pair\``
    : `${JSON.stringify(query)} is neither a device id nor a device name; candidates: ${devices.map(device => device.id).join(', ')}`;
}

function patchFor(capability: DaemonCapability, options: DeviceCommandOptions): DeviceGrantsPatch {
  return {
    [capability]: {
      ...(options.use === undefined ? {} : { use: options.use }),
      ...(options.configure === undefined ? {} : { configure: options.configure }),
    },
  } as DeviceGrantsPatch;
}
