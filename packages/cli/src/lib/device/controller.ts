import {
  DAEMON_CAPABILITIES,
  type DaemonCapability,
  type DeviceGrantsPatch,
  type PairedDevice,
} from '@ferretry/protocol';
import type { IDeviceGateway, IDeviceOutput } from './ports.ts';
import { renderDeviceChange, renderDevices } from './render.ts';

/** Flags the device commands accept. */
export interface DeviceCommandOptions {
  readonly json?: boolean;
  /** `--use` / `--no-use`; absent means "leave this axis alone". */
  readonly use?: boolean;
  /** `--configure` / `--no-configure`; absent means "leave this axis alone". */
  readonly configure?: boolean;
}

export interface DeviceControllerDeps {
  readonly gateway: IDeviceGateway;
  readonly out: IDeviceOutput;
  /** The command a human types, so every message names it rather than inventing one. */
  readonly clientName: string;
}

/**
 * Drives `fy device …`.
 *
 * Non-interactive throughout: this command line holds the admin token, so it is ungoverned and needs
 * no confirmation for any change, and a prompt would break an unattended run.
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
      this.fail(
        'nothing to change: name at least one axis, as `--use`/`--no-use` or `--configure`/`--no-configure`',
      );
      return;
    }
    const { devices } = await this.deps.gateway.list();
    const matches = matchDevices(devices, deviceQuery);
    const [device] = matches;
    if (device === undefined || matches.length > 1) {
      this.fail(describeMismatch(deviceQuery, matches, devices, this.deps.clientName));
      return;
    }
    const after = await this.deps.gateway.changeGrants(device.id, patchFor(target, options));
    const updated = after.devices.find(candidate => candidate.id === device.id);
    if (updated === undefined) {
      this.fail(`the daemon no longer lists ${device.id} after the change; it may have been revoked`);
      return;
    }
    this.deps.out.success(renderDeviceChange(updated));
  }

  private fail(message: string): void {
    this.deps.out.error(message);
    this.deps.out.setExitCode(1);
  }
}

/** An exact id wins outright; otherwise every device carrying exactly that name. */
function matchDevices(devices: readonly PairedDevice[], query: string): readonly PairedDevice[] {
  const byId = devices.filter(device => device.id === query);
  return byId.length > 0 ? byId : devices.filter(device => device.name === query);
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
