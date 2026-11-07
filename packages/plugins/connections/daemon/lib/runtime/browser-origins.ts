/**
 * THE BROWSER ORIGINS THIS DAEMON ANSWERS, copied from today's `browserOrigins(config)` (`fyd.ts`): the configured
 * browser origins (today's `corsOrigins`, default the hosted app), the operator's public address and the listener's
 * own, each once and in that order. A passkey's `clientData.origin` must equal one exactly (member passkeys, step-up).
 */
export interface BrowserOriginFacts {
  readonly corsOrigins: readonly string[];
  readonly publicUrl?: string;
  readonly host?: string;
  readonly port?: number;
}

const originOf = (value: string): string | undefined => {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
};

export function browserOrigins(facts: BrowserOriginFacts): readonly string[] {
  const host = facts.host;
  const bind =
    host === undefined || facts.port === undefined
      ? undefined
      : originOf(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${String(facts.port)}`);
  const all = [
    ...facts.corsOrigins,
    ...(facts.publicUrl === undefined ? [] : [originOf(facts.publicUrl)]),
    bind,
  ].filter((origin): origin is string => origin !== undefined);
  return [...new Set(all)];
}

/** The directory origin, or `undefined` for a value that is not one (`off`, blank). */
export const directoryOriginOf = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : originOf(value);
