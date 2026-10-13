import { stepUpRefusalCode } from '@ferretry/protocol';
import { FyHttpError, FyTransportError } from '@ferretry/protocol/client';
import type { IPasskeyGateway, IPasskeyLocalTime, IPasskeyOutput } from './ports.ts';
import {
  renderAmbiguous,
  renderDaemonUnreachable,
  renderDeviceGone,
  renderNoSuchDevice,
  renderNotAtMachine,
  renderOpened,
} from './render.ts';
import { resolveDevice } from './resolve.ts';

export interface PasskeyControllerDeps {
  readonly gateway: IPasskeyGateway;
  readonly out: IPasskeyOutput;
  readonly time: IPasskeyLocalTime;
  /** What this binary is called, so every hint is a command the owner actually has. */
  readonly binaryName: string;
}

/**
 * Drives `fy passkey window <device>`.
 *
 * ONE SENTENCE IN, ONE SENTENCE OUT. Every ending — opened, no such device, two such devices, refused,
 * unreachable — is a single plain sentence naming what to do next, and every ending but the first
 * exits 1: the owner asked for a window and none is open.
 *
 * REFUSALS ARE READ FROM THE DAEMON'S CODE, never from its prose, because the code is the contract and
 * the sentence is allowed to change. Anything this does not recognise is rethrown for the composition
 * root to print as it prints every other failure, rather than being flattened into a sentence that
 * claims to know what went wrong.
 */
export class PasskeyController {
  constructor(private readonly deps: PasskeyControllerDeps) {}

  async window(query: string): Promise<void> {
    try {
      const resolution = resolveDevice(await this.deps.gateway.devices(), query);
      if (resolution.kind === 'none')
        return this.#refuse(renderNoSuchDevice(query, resolution.known, this.deps.binaryName));
      if (resolution.kind === 'ambiguous') return this.#refuse(renderAmbiguous(query, resolution.candidates));
      const opened = await this.deps.gateway.openWindow(resolution.device.id);
      this.deps.out.success(renderOpened(opened, this.deps.time.clockTime(opened.closesAt)));
    } catch (error) {
      if (error instanceof FyTransportError) return this.#refuse(renderDaemonUnreachable(this.deps.binaryName));
      if (error instanceof FyHttpError && error.code === stepUpRefusalCode('not-at-machine')) {
        return this.#refuse(renderNotAtMachine());
      }
      if (error instanceof FyHttpError && error.code === stepUpRefusalCode('unknown-device')) {
        return this.#refuse(renderDeviceGone(this.deps.binaryName));
      }
      throw error;
    }
  }

  #refuse(sentence: string): void {
    this.deps.out.error(sentence);
    this.deps.out.setExitCode(1);
  }
}
