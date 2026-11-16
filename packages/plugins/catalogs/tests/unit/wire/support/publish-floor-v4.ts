/**
 * The publish rule v4 Catalogs refused by, FROZEN from f5eafc9d40
 * (`packages/plugins/catalogs/contract/wire/shared-catalog.ts`: `holdsRawKey`, `addressHoldsRawKey`, and
 * `RAW_KEY_PREFIXES` of `foreign.ts`), copied so the one rule is held to it. Do not edit.
 *
 * It is a test ORACLE only, like Runtimes' #37 floor: the product has one rule, and it refuses at least whatever this
 * refused.
 */

const RAW_KEY_PREFIXES =
  /^(?:sk-|sk_live_|sk_test_|rk_live_|AKIA|ASIA|ghp_|gho_|ghs_|ghu_|github_pat_|glpat-|xox[abposr]-|AIza|hf_|pk_live_)/u;

const pieces = (value: string): readonly string[] => value.split(/[\s=&?#/:,;"'`]+/u).filter(piece => piece !== '');

const KEY_WORDS = new Set([
  'key',
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'pass',
  'pwd',
  'credential',
  'credentials',
  'auth',
  'pat',
  'bearer',
  'basic',
]);

const announcesKey = (name: string): boolean =>
  name
    .toLowerCase()
    .split(/[-_.]+/u)
    .some(word => KEY_WORDS.has(word));

const prefixedKey = (piece: string): boolean => RAW_KEY_PREFIXES.test(piece) && piece.length >= 20;

/** Whether a command, an argument or a value carried a raw key. */
export const holdsRawKey = (value: string): boolean => {
  const parts = pieces(value);
  return parts.some(
    (part, index) => prefixedKey(part) || (index > 0 && announcesKey(parts[index - 1] ?? '') && part.length >= 16),
  );
};

/** Whether an address carried a raw key. */
export const addressHoldsRawKey = (url: string): boolean => {
  if (pieces(url).some(prefixedKey)) return true;
  const query = url.split(/[?#]/u)[1] ?? '';
  return query.split('&').some(pair => {
    const [name = '', value = ''] = pair.split('=');
    return announcesKey(name) && value.length >= 16;
  });
};

/** Whether v4 refused these arguments. */
export const oldArgs = (args: readonly string[]): boolean =>
  args.some((arg, index) => holdsRawKey(arg) || holdsRawKey(`${args[index - 1] ?? ''} ${arg}`));

/** Whether v4 refused this environment (a whole `${secret:NAME}` value was always taken). */
export const oldEnv = (env: Readonly<Record<string, string>>): boolean =>
  Object.entries(env).some(
    ([key, value]) => !/^\$\{secret:[A-Za-z0-9_.-]+\}$/u.test(value) && holdsRawKey(`${key} ${value}`),
  );
