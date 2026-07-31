import {
  loadDaemonSecrets,
  type DaemonSecretsLoadStatus,
  type EnvironmentWriterPort,
  type SecretShellPort,
} from '../../lib/index.ts';

export const daemonSecretSourceProgram =
  'set -a; . "$1" >/dev/null 2>&1 || exit 1; exec "$2" -e "process.stdout.write(JSON.stringify(process.env))"';

export interface SecretProcessPort {
  source(file: string): Readonly<{ success: boolean; stdout: string }>;
}

/** Shell adapter that imports a configured secrets file without emitting its contents. */
export class BunSecretShell implements SecretShellPort {
  constructor(private readonly process: SecretProcessPort) {}

  async source(file: string): Promise<Readonly<Record<string, string>> | undefined> {
    const result = this.process.source(file);
    if (!result.success) return undefined;
    const decoded: unknown = JSON.parse(result.stdout);
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded))
      throw new Error('invalid secret environment');
    const entries = Object.entries(decoded);
    if (entries.some(([, value]) => typeof value !== 'string')) throw new Error('invalid secret environment');
    return Object.fromEntries(entries) as Readonly<Record<string, string>>;
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
