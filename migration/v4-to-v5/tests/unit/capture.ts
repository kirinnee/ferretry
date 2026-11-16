/** Everything written to stdout, stderr, the console or `process.emitWarning` while `work` runs. */
export async function captured(work: () => Promise<unknown>): Promise<string> {
  const seen: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const warn = process.emitWarning.bind(process);
  const consoleKeys = ['log', 'warn', 'error', 'info', 'debug'] as const;
  const saved = consoleKeys.map(key => console[key]);
  const record = (...parts: unknown[]) => {
    seen.push(parts.map(part => (part instanceof Error ? `${part.name}: ${part.message}` : String(part))).join(' '));
    return true;
  };
  process.stdout.write = record as never;
  process.stderr.write = record as never;
  process.emitWarning = record as never;
  for (const key of consoleKeys) console[key] = record as never;
  try {
    await work();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    process.emitWarning = warn;
    consoleKeys.forEach((key, index) => (console[key] = saved[index] as never));
  }
  return seen.join('\n');
}
