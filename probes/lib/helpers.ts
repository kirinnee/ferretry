import type { ProbeExecResult, ProbeRepo } from './contracts.ts';

const timeoutMs = 600_000;

export async function expectGreen(repo: ProbeRepo, command: string, label: string): Promise<void> {
  const result: ProbeExecResult = await repo.exec(command, { timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed on the healthy repo: ${result.stderr || result.stdout}`);
  }
}

export async function expectRed(repo: ProbeRepo, command: string, label: string): Promise<void> {
  const result = await repo.exec(command, { timeoutMs });
  if (result.exitCode === 0) {
    throw new Error(`${label} stayed green after sabotage`);
  }
}
