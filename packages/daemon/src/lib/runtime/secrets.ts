export type DaemonSecretsLoadStatus = 'loaded' | 'missing' | 'failed';

export interface SecretShellPort {
  source(file: string): Promise<Readonly<Record<string, string>> | undefined>;
}

export interface EnvironmentWriterPort {
  set(key: string, value: string): void;
}

/** Imports only valid variable names and never exposes their values in diagnostics. */
export async function loadDaemonSecrets(
  shell: SecretShellPort,
  environment: EnvironmentWriterPort,
  file: string | undefined,
): Promise<DaemonSecretsLoadStatus> {
  if (file === undefined) return 'missing';
  try {
    const values = await shell.source(file);
    if (values === undefined) return 'missing';
    for (const [key, value] of Object.entries(values)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || protectedEnvironmentKey(key)) continue;
      environment.set(key, value);
    }
    return 'loaded';
  } catch {
    return 'failed';
  }
}

function protectedEnvironmentKey(key: string): boolean {
  return new Set(['HOME', 'LOGNAME', 'PATH', 'PWD', 'SHELL', 'SHLVL', 'TMPDIR', 'USER']).has(key);
}
