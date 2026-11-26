/** Like ssh-agent: unsealed key in daemon memory, socket + PUBLIC keyring in the ferret's environment. */
import type { Clock, Log, SpawnPort } from '@ferretry/kernel/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { GIT_ACCOUNT_CODES, type GitAccountId } from '../../../contract/index.ts';
import type { TrustedLaunch } from '../../lib/program-locator.ts';
import type { RunFolder } from '../ssh-keys/agents.ts';
import { listenGpg, type GpgListen, type GpgListener } from '../../adapters/gpg-socket.ts';
import { makeGpg, receiveGpg, privateKeyOf, signGpg, type GpgIdentity, type GpgMaterial } from './material.ts';
import { gpgShim } from './shim.ts';

export interface GpgKit {
  readonly home: string;
  readonly fingerprint: string;
  readonly program: string;
}
const unavailable = () =>
  new ApiError(503, 'the GPG signer for this Git account could not be started', GIT_ACCOUNT_CODES.agentUnavailable);

export class GpgSigners {
  readonly #running = new Map<GitAccountId, { kit: GpgKit; listener: GpgListener }>();
  readonly #known = new Set<GitAccountId>();
  readonly #starting = new Set<Promise<GpgKit>>();
  #stopped = false;
  constructor(
    private readonly spawn: Pick<SpawnPort, 'run'>,
    private readonly folder: RunFolder,
    private readonly log: Pick<Log, 'warn'>,
    private readonly clock: Pick<Clock, 'after'>,
    private readonly programs: { gpg(): Promise<TrustedLaunch>; curl(): Promise<TrustedLaunch> },
    private readonly listen: GpgListen = listenGpg,
  ) {}

  generate(_id: GitAccountId, identity: GpgIdentity): Promise<GpgMaterial> {
    return makeGpg(identity);
  }
  receive(_id: GitAccountId, secret: string, identity: GpgIdentity): Promise<GpgMaterial> {
    return receiveGpg(secret, identity);
  }

  kit(id: GitAccountId, secret: string): Promise<GpgKit> {
    const started = this.#start(id, secret);
    this.#starting.add(started);
    void started.finally(() => this.#starting.delete(started)).catch(() => undefined);
    return started;
  }

  async #start(id: GitAccountId, secret: string): Promise<GpgKit> {
    if (this.#stopped) throw unavailable();
    const held = this.#running.get(id);
    if (held !== undefined) return held.kit;
    const socket = `${this.folder.path}/${id}.gpg.sock`;
    if (socket.length > 100 || !(await this.folder.isPrivate())) throw unavailable();
    try {
      const key = await privateKeyOf(secret);
      const gpg = await this.programs.gpg();
      const curl = await this.programs.curl();
      await this.forget(id);
      this.#known.add(id);
      // This keyring has ONLY public packets. No gpg-agent is started and no secret import exists.
      const home = `${this.folder.path}/${id}.gpg-public`;
      await this.folder.emptyDirectory(`${id}.gpg-public`, 0o700);
      const imported = await this.spawn.run(gpg.program, ['--no-options', '--batch', '--no-autostart', '--import'], {
        sealed: true,
        env: { GNUPGHOME: home, PATH: gpg.path },
        stdin: key.toPublic().armor(),
        timeout: milliseconds(10_000),
      });
      if (imported.exitCode !== 0 || this.#stopped) throw unavailable();
      const fingerprint = key.getFingerprint().toUpperCase();
      const kit = { home, fingerprint, program: `${this.folder.path}/${id}.gpg-sign` };
      await this.folder.publish(
        `${id}.gpg-sign`,
        gpgShim({ socket, fingerprint, home, gpg: gpg.program, curl: curl.program }),
        0o700,
      );
      if (this.#stopped) throw unavailable();
      const listener = await this.listen(
        socket,
        async payload => {
          if (this.#stopped) throw unavailable();
          const signed = await signGpg(key, payload);
          if (this.#stopped) throw unavailable();
          return signed;
        },
        this.clock,
      );
      if (this.#stopped) {
        await listener.stop();
        throw unavailable();
      }
      this.#running.set(id, { kit, listener });
      return kit;
    } catch {
      await this.forget(id);
      this.log.warn('git-accounts: an account GPG signer could not be started', { account: id });
      throw unavailable();
    }
  }

  /** Remove capability FIRST; propagate disk cleanup failures so metadata remains available to retry. */
  async disable(id: GitAccountId): Promise<void> {
    const running = this.#running.get(id);
    if (running !== undefined) {
      await running.listener.stop();
      this.#running.delete(id);
    }
  }

  async forget(id: GitAccountId): Promise<void> {
    await this.disable(id);
    for (const name of [`${id}.gpg.sock`, `${id}.gpg-sign`, `${id}.gpg-public`]) await this.folder.remove(name);
    this.#known.delete(id);
  }

  async stopAll(): Promise<void> {
    this.#stopped = true;
    await Promise.allSettled([...this.#starting]);
    const results = await Promise.allSettled([...this.#known].map(id => this.forget(id)));
    if (results.some(result => result.status === 'rejected'))
      this.log.warn('git-accounts: public GPG signer files could not all be removed');
  }
}
