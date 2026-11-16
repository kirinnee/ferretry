import { describe, expect, it } from 'bun:test';
import { CatalogMcpSetupSchema } from '../../../contract/wire/shared-catalog.ts';
import { addressHoldsRawKey, holdsRawKey, oldArgs, oldEnv } from './support/publish-floor-v4.ts';

// Fake values only. V is a fake 22-character value without a prefix; the tokens are fake, 20 characters of body.
const V = 'fakevalue0000000000000';
const TOKENS = ['rk_live_', 'sk_test_', 'pk_live_', 'gho_', 'ghp_', 'sk-'].map(
  prefix => `${prefix}aaaaaaaaaaaaaaaaaaaa`,
);
const FLAGS = [
  '--key',
  '--pass',
  '--pwd',
  '--bearer',
  '--basic',
  '--auth',
  '--api-key',
  '--token',
  '--secret',
  '--client-key',
  '--license-key',
  '--master-key',
  '--signing-key',
  '--private-key',
  '--pat',
];
const SEPARATORS = [' ', '=', ':', '/', ',', ';', '?', '&', '#', '\n', '"', "'"];

/** The shapes the floor is held to: every one is a setup, with whether v4 refused it. */
interface Shape {
  readonly label: string;
  readonly setup: Record<string, unknown>;
  readonly v4Refused: boolean;
}

const COMMAND = { transport: 'command', command: 'npx', args: [] as string[], env: {} as Record<string, string> };

function shapes(): readonly Shape[] {
  const out: Shape[] = [];
  const args = (a: string[]): void => {
    out.push({ label: `args ${JSON.stringify(a)}`, setup: { ...COMMAND, args: a }, v4Refused: oldArgs(a) });
  };
  const env = (e: Record<string, string>): void => {
    out.push({ label: `env ${JSON.stringify(e)}`, setup: { ...COMMAND, env: e }, v4Refused: oldEnv(e) });
  };
  const url = (u: string): void => {
    if (/^https?:\/\/[^\s/?#@]+(?:[/?#][^\s]*)?$/u.test(u))
      out.push({ label: `url ${u}`, setup: { transport: 'url', url: u }, v4Refused: addressHoldsRawKey(u) });
  };
  for (const flag of FLAGS) {
    args([flag, V]);
    for (const separator of SEPARATORS) {
      args([`${flag}${separator}${V}`]);
      args([`x${separator}${flag.replace(/^-+/u, '')}${separator}${V}`]);
    }
  }
  for (const token of TOKENS)
    for (const separator of SEPARATORS) {
      args([`x${separator}${token}`]);
      env({ NOTE: `x${separator}${token}` });
      url(`https://h.example.invalid/p${separator === '/' ? '/' : '/x'}${separator}${token}`);
      out.push({
        label: `command npx${separator}${token}`,
        setup: { ...COMMAND, command: `npx${separator}${token}` },
        v4Refused: holdsRawKey(`npx${separator}${token}`),
      });
    }
  for (const name of [
    'KEY',
    'PASS',
    'PWD',
    'LICENSE_KEY',
    'SIGNING_KEY',
    'MASTER_KEY',
    'DB_PASS',
    'BEARER',
    'CLIENT_KEY',
    'OPTS',
  ]) {
    env({ [name]: V });
    for (const flag of FLAGS) env({ [name]: `${flag} ${V}` });
  }
  for (const query of [
    'key',
    'pass',
    'pwd',
    'auth',
    'apikey',
    'api_key',
    'token',
    'access_token',
    'secret',
    'client-secret',
    'sig',
  ]) {
    url(`https://h.example.invalid/x?${query}=${V}`);
    url(`https://h.example.invalid/x#${query}=${V}`);
  }
  return out;
}

describe('the publish floor (R-0261 britnee #41: a catalog refuses at least what v4 refused)', () => {
  it('R-0261 should refuse every generated shape the v4 publish rule refused (G-B1 closed: the residual is exactly 0)', () => {
    const all = shapes();
    const v4 = all.filter(shape => shape.v4Refused);
    const residual = v4.filter(shape => CatalogMcpSetupSchema.safeParse(shape.setup).success).map(shape => shape.label);
    // A floor that refused nothing would pass the line below; the generator must reach hundreds of refused shapes.
    expect(v4.length).toBeGreaterThan(400);
    expect(residual).toEqual([]);
  });
});
