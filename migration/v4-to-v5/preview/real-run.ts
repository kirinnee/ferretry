/** The start checks' real runner: one program, an environment that is exactly `env`, stdin closed, a 20 second bound. */
import type { Run } from './start-checks.ts';

const TIMEOUT_MS = 20_000;

export const realRun: Run = async (argv, env) => {
  try {
    const child = Bun.spawn([...argv], {
      env: { ...env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, stdout };
  } catch {
    // The program is not there (or could not be started): the caller reads that as "not installed".
    return { code: undefined, stdout: '' };
  }
};
