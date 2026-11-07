import { readdir, readFile } from '../host/fs.ts';
import { join } from 'node:path';
import {
  type CgroupHostFacts,
  parseWeightFile,
  type ServiceWeights,
  type ServiceWeightsPort,
  sliceCgroupPath,
  userManagerPath,
  VOICE_SLICE,
} from '../../lib/cgroups/index.ts';

const text = async (path: string): Promise<string | undefined> => await readFile(path, 'utf8').catch(() => undefined);

/**
 * Reads the CPU weight the kernel holds for the daemon and for the voice worker, straight from their
 * cgroups' `cpu.weight` — plain async file reads, like {@link CgroupFleetMemory}.
 *
 * The daemon's weight is that of its OWN cgroup (the path `/proc/self/cgroup` named at boot), so a unit
 * edited, or `set-property` run, since the status was last written shows up as what it is now. The voice
 * worker's is its slice's, under the daemon's user manager, and counts only while a scope is alive in it:
 * a slice with no worker holds nothing the worker has been given.
 */
export class CgroupServiceWeights implements ServiceWeightsPort {
  private readonly daemonDirectory: string | undefined;
  private readonly voiceDirectory: string | undefined;

  constructor(host: CgroupHostFacts, cgroupRoot = '/sys/fs/cgroup', slice: string = VOICE_SLICE) {
    const manager = host.ownCgroup === undefined ? undefined : userManagerPath(host.ownCgroup);
    this.daemonDirectory = host.ownCgroup === undefined ? undefined : join(cgroupRoot, host.ownCgroup);
    this.voiceDirectory = manager === undefined ? undefined : join(cgroupRoot, manager, ...sliceCgroupPath(slice));
  }

  async read(): Promise<ServiceWeights> {
    const [daemon, voice] = await Promise.all([this.weight(this.daemonDirectory), this.voice()]);
    return { ...(daemon === undefined ? {} : { daemon }), ...voice };
  }

  private async weight(directory: string | undefined): Promise<number | undefined> {
    if (directory === undefined) return undefined;
    return parseWeightFile((await text(join(directory, 'cpu.weight'))) ?? '');
  }

  private async voice(): Promise<Pick<ServiceWeights, 'voice' | 'voiceState'>> {
    if (this.voiceDirectory === undefined) return { voiceState: 'unknown' };
    const children = await readdir(this.voiceDirectory).then(
      names => names,
      (error: unknown) => ((error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined),
    );
    // A slice that cannot be read says nothing about the worker (permission, I/O): unknown, never "not running".
    if (children === undefined) return { voiceState: 'unknown' };
    // No slice at all, or one with no live scope, is a worker that is not running — not a reading failure.
    if (!children.some(child => child.endsWith('.scope'))) return { voiceState: 'not-running' };
    const voice = await this.weight(this.voiceDirectory);
    return { voiceState: 'running', ...(voice === undefined ? {} : { voice }) };
  }
}
