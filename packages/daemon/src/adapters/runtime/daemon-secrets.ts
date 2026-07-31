import {
  loadDaemonSecrets,
  type DaemonSecretsLoadStatus,
  type EnvironmentWriterPort,
  type SecretShellPort,
} from '../../lib/index.ts';

const sourceProgram =
  'set -a; . "$1" >/dev/null 2>&1 || exit 1; exec "$2" -e "process.stdout.write(JSON.stringify(process.env))"';

/** Shell adapter that imports a configured secrets file without emitting its contents. */
export class BunSecretShell implements SecretShellPort {
  async source(file: string): Promise<Readonly<Record<string, string>> | undefined> {
    const child = Bun.spawnSync({
      cmd: ['/bin/sh', '-c', sourceProgram, 'fyd-secrets', file, process.execPath],
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 5_000,
      maxBuffer: 1_024 * 1_024,
    });
    if (!child.success) return undefined;
    const decoded: unknown = JSON.parse(child.stdout.toString());
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded))
      throw new Error('invalid secret environment');
    const entries = Object.entries(decoded);
    if (entries.some(([, value]) => typeof value !== 'string')) throw new Error('invalid secret environment');
    return Object.fromEntries(entries) as Readonly<Record<string, string>>;
  }
}

export class ProcessEnvironmentWriter implements EnvironmentWriterPort {
  set(key: string, value: string): void {
    process.env[key] = value;
  }
}

export class DaemonSecretsLoader {
  constructor(
    private readonly shell: SecretShellPort,
    private readonly environment: EnvironmentWriterPort,
  ) {}

  async load(file: string | undefined): Promise<DaemonSecretsLoadStatus> {
    return await loadDaemonSecrets(this.shell, this.environment, file);
  }
}
