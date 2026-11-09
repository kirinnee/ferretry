import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { LoginFileSchema } from '@ferretry/plugin-logins/contract';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { FileSecretDocumentStore } from '../../../../packages/core/vault/daemon/adapters/secrets/file-secret-document-store.ts';
import type { SealedFiles } from '../../../../packages/core/vault/daemon/adapters/secrets/kernel-sealed-files.ts';
import {
  FileSecretKey,
  WebCryptoSecretCipher,
} from '../../../../packages/core/vault/daemon/adapters/secrets/webcrypto-secret-cipher.ts';
import { isPlainLoginKey, LoginKeyHold, loginKeysStep, sealValues, writeAtomic } from '../../src/steps/login-keys.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { vaultStep } from '../../src/steps/secrets.ts';
import type { StepReport } from '../../src/report.ts';
import type { StepContext } from '../../src/steps/index.ts';
import { fixture } from './ferret-fixture.ts';

// Fixtures only: every key below is made up, in a temp folder, and no real home is read.
const KEY = `sk-ant-${'FAKE0123'.repeat(5)}`;
const OTHER_KEY = `sk-or-${'FAKE4567'.repeat(5)}`;
const PLACEHOLDER = 'ollama';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const login = async (id: string, env: string) => {
  const target = join(f.from, 'config', 'logins', `${id}.yaml`);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, `harness: claude\nstore: environment\nenv:\n${env}`, { mode: 0o600 });
};

/** The vault's own file adapter shape over a folder: `vault.json` and `vault.key` (v4: `secrets.json`, `secrets.key`). */
function filesAt(folder: string, names = { vault: 'vault.json', key: 'vault.key' }): SealedFiles {
  return {
    async readText(file) {
      return await readFile(join(folder, names[file]), 'utf8').catch(() => undefined);
    },
    async writeText(file, text) {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(join(folder, names[file]), text, { mode: 0o600 });
    },
  };
}

/** Every secret the v5 vault holds, opened by the vault's OWN reader (the real store and the real cipher). */
async function openedByTheVault(home: string): Promise<ReadonlyMap<string, string>> {
  const files = filesAt(join(home, 'state', 'vault'));
  const document = await new FileSecretDocumentStore(files).read();
  if (document === undefined) return new Map();
  return await new WebCryptoSecretCipher(new FileSecretKey(files)).openAll(document.entries);
}

/** A v4 vault with one entry sealed by the vault's own writer, written in v4's envelope (`v: 1`). */
async function v4Vault(entry: { name: string; value: string }) {
  const files = filesAt(join(f.from, 'state'), { vault: 'secrets.json', key: 'secrets.key' });
  const cipher = new WebCryptoSecretCipher(new FileSecretKey(files));
  const sealed = await cipher.seal(entry.name, entry.value);
  const stamped = { ...sealed, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' };
  await writeFile(
    join(f.from, 'state', 'secrets.json'),
    `${JSON.stringify({ v: 1, cipher: 'AES-256-GCM', entries: { [entry.name]: stamped } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return stamped;
}

interface Run {
  readonly reports: Record<string, StepReport>;
  readonly output: string;
}

/** Settings, then the vault step, then login-keys (the order `STEPS` runs them in), capturing all console output. */
async function run(dryRun = false, hold: LoginKeyHold | null = new LoginKeyHold()): Promise<Run> {
  const lines: string[] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
    spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    }),
  );
  try {
    const ctx: StepContext = { ...f.ctx(dryRun), ...(hold === null ? {} : { loginKeys: hold }) };
    const reports: Run['reports'] = {};
    for (const step of [settingsStep, vaultStep, loginKeysStep]) reports[step.id] = await step.run(ctx);
    return { reports, output: lines.join('\n') };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** Every file under a folder, as text (the vault's ciphertext and the key included: none may hold a plain key). */
async function everyFileText(folder: string): Promise<string[]> {
  const texts: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) texts.push(await readFile(join(entry.parentPath, entry.name), 'utf8'));
  }
  return texts;
}

const v5Login = async (id: string) =>
  LoginFileSchema.parse(parse(await readFile(join(f.to, 'config', 'logins', `${id}.yaml`), 'utf8')));

describe('login keys move out of the login file and into the vault', () => {
  test('a 40-character key under ANTHROPIC_API_KEY becomes ${secret:…} and the vault holds it (by use)', async () => {
    await login('work', `  ANTHROPIC_API_KEY: ${KEY}\n`);
    const { reports, output } = await run();

    expect(reports.settings?.status).toBe('converted');
    expect(reports.vault?.status).toBe('converted');
    expect(reports['login-keys']?.status).toBe('converted');
    expect((await v5Login('work')).env?.ANTHROPIC_API_KEY).toBe('${secret:LOGIN_WORK_ANTHROPIC_API_KEY}');

    // The vault's own reader opens the entry this tool sealed (a minted key: the v4 home had none).
    const opened = await openedByTheVault(f.to);
    expect(opened.get('LOGIN_WORK_ANTHROPIC_API_KEY') === KEY).toBe(true);
    expect([...opened.keys()]).toEqual(['LOGIN_WORK_ANTHROPIC_API_KEY']);
    for (const file of ['vault.json', 'vault.key'])
      expect((await stat(join(f.to, 'state', 'vault', file))).mode & 0o777).toBe(0o600);

    // The report names login, variable and secret NAME, and holds no value; no log line and no file does either.
    expect(reports['login-keys']?.kept.map(item => item.what)).toEqual([
      'LOGIN_WORK_ANTHROPIC_API_KEY (login work, variable ANTHROPIC_API_KEY)',
    ]);
    expect(JSON.stringify(reports).includes(KEY)).toBe(false);
    expect(output.includes(KEY)).toBe(false);
    const plain = (await everyFileText(join(f.to, 'config'))).concat(await everyFileText(join(f.to, 'state')));
    expect(plain.some(text => text.includes(KEY))).toBe(false);
  });

  test('a 6-character placeholder stays plain and an existing reference is untouched', async () => {
    await login('local', `  OPENAI_API_KEY: ${PLACEHOLDER}\n  ANTHROPIC_AUTH_TOKEN: \${secret:ALREADY_THERE}\n`);
    const { reports } = await run();

    expect(reports['login-keys']?.status).toBe('converted');
    expect(reports['login-keys']?.note).toBe('no login holds a plain key');
    const env = (await v5Login('local')).env;
    expect(env?.OPENAI_API_KEY).toBe(PLACEHOLDER);
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBe('${secret:ALREADY_THERE}');
    await expect(stat(join(f.to, 'state', 'vault', 'vault.json'))).rejects.toThrow();
  });

  test('a name that is taken is de-duplicated, against the v4 vault and within the run, and nothing is overwritten', async () => {
    const existing = await v4Vault({ name: 'LOGIN_WORK_ANTHROPIC_API_KEY', value: 'an-older-secret-value' });
    await login('work', `  ANTHROPIC_API_KEY: ${KEY}\n`);
    // `a-b` + `C_D` and `a` + `B_C_D` both want LOGIN_A_B_C_D.
    await login('a-b', `  C_D: ${OTHER_KEY}\n`);
    await login('a', `  B_C_D: ${OTHER_KEY.replace('FAKE4567', 'FAKE8901')}\n`);
    const { reports } = await run();

    expect(reports['login-keys']?.status).toBe('converted');
    expect((await v5Login('work')).env?.ANTHROPIC_API_KEY).toBe('${secret:LOGIN_WORK_ANTHROPIC_API_KEY_2}');
    const names = [(await v5Login('a')).env?.B_C_D, (await v5Login('a-b')).env?.C_D].sort();
    expect(names).toEqual(['${secret:LOGIN_A_B_C_D_2}', '${secret:LOGIN_A_B_C_D}']);

    const opened = await openedByTheVault(f.to);
    expect(opened.get('LOGIN_WORK_ANTHROPIC_API_KEY') === 'an-older-secret-value').toBe(true);
    expect(opened.get('LOGIN_WORK_ANTHROPIC_API_KEY_2') === KEY).toBe(true);
    expect(opened.size).toBe(4);

    // The v4 entry was copied byte for byte (never decrypted and sealed again).
    const document = JSON.parse(await readFile(join(f.to, 'state', 'vault', 'vault.json'), 'utf8')) as {
      entries: Record<string, unknown>;
    };
    expect(document.entries.LOGIN_WORK_ANTHROPIC_API_KEY).toEqual(existing);
  });

  test('a dry run seals nothing, writes nothing and names the planned secrets', async () => {
    await login('work', `  ANTHROPIC_API_KEY: ${KEY}\n`);
    const { reports, output } = await run(true);

    expect(reports['login-keys']?.status).toBe('converted');
    expect(reports['login-keys']?.note).toBe('dry run: nothing sealed');
    expect(reports['login-keys']?.kept.length).toBe(1);
    await expect(readdir(f.to)).rejects.toThrow();
    expect((JSON.stringify(reports) + output).includes(KEY)).toBe(false);
  });
});

describe('a key is never left plain', () => {
  test('never plain: with no hold to park it in, Settings fails and writes no login file', async () => {
    await login('work', `  ANTHROPIC_API_KEY: ${KEY}\n`);
    const { reports, output } = await run(false, null);

    expect(reports.settings?.status).toBe('failed');
    expect(reports.settings?.note).toContain('config/logins/work.yaml');
    expect(JSON.stringify(reports).includes(KEY)).toBe(false);
    expect(output.includes(KEY)).toBe(false);
    await expect(stat(join(f.to, 'config', 'logins', 'work.yaml'))).rejects.toThrow();
  });

  test('never plain: when sealing fails the step fails naming login, variable and path, and holds no value', async () => {
    await login('work', `  ANTHROPIC_API_KEY: ${KEY}\n`);
    // A vault that is not a vault: the step cannot add to it, so the run has no home.json.
    await mkdir(join(f.from, 'state'), { recursive: true });
    await writeFile(join(f.from, 'state', 'secrets.key'), `${Buffer.alloc(32, 7).toString('base64')}\n`);
    await writeFile(
      join(f.from, 'state', 'secrets.json'),
      `${JSON.stringify({ v: 1, cipher: 'AES-256-GCM', entries: {} })}\n`,
    );
    const hold = new LoginKeyHold();
    const ctx: StepContext = { ...f.ctx(), loginKeys: hold };
    expect((await settingsStep.run(ctx)).status).toBe('converted');
    expect((await vaultStep.run(ctx)).status).toBe('converted');
    await writeFile(join(f.to, 'state', 'vault', 'vault.json'), 'not json');
    const report = await loginKeysStep.run(ctx);

    expect(report.status).toBe('failed');
    expect(report.note).toContain('login work variable ANTHROPIC_API_KEY');
    expect(report.note).toContain('state/vault/vault.json');
    expect(JSON.stringify(report).includes(KEY)).toBe(false);
    expect(hold.size).toBe(0);
    expect(await readdir(join(f.to, 'state', 'vault'))).not.toContain('vault.json.tmp');
    expect((await everyFileText(join(f.to, 'state', 'vault'))).some(text => text.includes(KEY))).toBe(false);
  });

  test('never plain: a vault already at its limit fails the step', async () => {
    await login('work', `  ANTHROPIC_API_KEY: ${KEY}\n`);
    const entry = { iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'Q0lQSEVS', createdAt: 'x', updatedAt: 'x' };
    const entries = Object.fromEntries(Array.from({ length: 256 }, (_, n) => [`FULL_${String(n)}`, entry]));
    await mkdir(join(f.from, 'state'), { recursive: true });
    await writeFile(join(f.from, 'state', 'secrets.key'), `${Buffer.alloc(32, 7).toString('base64')}\n`);
    await writeFile(join(f.from, 'state', 'secrets.json'), JSON.stringify({ v: 1, cipher: 'AES-256-GCM', entries }));
    const { reports } = await run();

    expect(reports['login-keys']?.status).toBe('failed');
    expect(reports['login-keys']?.note).toContain('login work variable ANTHROPIC_API_KEY');
    expect(JSON.stringify(reports).includes(KEY)).toBe(false);
  });

  test('the rule is the shared one: a key by shape or by credential name, never a reference or a short value', () => {
    expect(isPlainLoginKey('ANTHROPIC_API_KEY', KEY)).toBe(true);
    expect(isPlainLoginKey('GATEWAY_TOKEN', 'Zq7kP2mX9vL4nB8cR3tY6wH1')).toBe(true);
    expect(isPlainLoginKey('SOME_SETTING', KEY)).toBe(true);
    expect(isPlainLoginKey('ANTHROPIC_API_KEY', PLACEHOLDER)).toBe(false);
    expect(isPlainLoginKey('ANTHROPIC_API_KEY', '${secret:ALREADY_THERE}')).toBe(false);
    expect(isPlainLoginKey('ANTHROPIC_BASE_URL', 'https://api.example.com')).toBe(false);
  });
});

describe('the seal agrees with the vault', () => {
  const key = Buffer.alloc(32, 9);

  test('what this tool seals opens with the vault’s own reader, under the key it was sealed with', async () => {
    const dir = join(f.root, 'agree');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'vault.key'), `${key.toString('base64')}\n`);
    const sealed = await sealValues(Buffer.from(key), [{ name: 'LOGIN_X_Y', value: KEY }]);
    const [only] = sealed;
    expect(sealed.length).toBe(1);
    const document = {
      format: 1,
      cipher: 'AES-256-GCM',
      entries: { LOGIN_X_Y: { iv: only?.iv, ciphertext: only?.ciphertext, createdAt: 't', updatedAt: 't' } },
    };
    await writeFile(join(dir, 'vault.json'), JSON.stringify(document));
    const files = filesAt(dir);
    const read = await new FileSecretDocumentStore(files).read();
    const opened = await new WebCryptoSecretCipher(new FileSecretKey(files)).openAll(read?.entries ?? {});
    expect(opened.get('LOGIN_X_Y') === KEY).toBe(true);
  });

  test('what the vault’s own writer seals opens with this tool’s reading of the format (a golden both ways)', async () => {
    const dir = join(f.root, 'golden');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'vault.key'), `${key.toString('base64')}\n`);
    const files = filesAt(dir);
    const golden = await new WebCryptoSecretCipher(new FileSecretKey(files)).seal('LOGIN_X_Y', KEY);
    // The documented format, read by hand: AES-256-GCM, 96-bit IV, the NAME as AAD.
    const aes = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
    const open = async (name: string) =>
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: Buffer.from(golden.iv, 'base64'), additionalData: new TextEncoder().encode(name) },
          aes,
          Buffer.from(golden.ciphertext, 'base64'),
        ),
      );
    expect((await open('LOGIN_X_Y')) === KEY).toBe(true);
    // The name is bound: the same bytes under another name do not open.
    await expect(open('LOGIN_X_Z')).rejects.toThrow();
  });

  test('the key bytes are zeroed once sealing is done, and again when it fails', async () => {
    const live = Buffer.from(key);
    await sealValues(live, [{ name: 'LOGIN_X_Y', value: KEY }]);
    expect(live.every(byte => byte === 0)).toBe(true);

    const short = Buffer.alloc(16, 5);
    await expect(sealValues(short, [{ name: 'LOGIN_X_Y', value: KEY }])).rejects.toThrow();
    expect(short.every(byte => byte === 0)).toBe(true);
  });

  test('a key this tool mints is one the vault’s own reader accepts', async () => {
    await login('work', `  ANTHROPIC_API_KEY: ${KEY}\n`);
    await run();
    const material = await new FileSecretKey(filesAt(join(f.to, 'state', 'vault'))).read();
    expect(material?.byteLength).toBe(32);
  });
});

describe('writeAtomic', () => {
  test('writes 0600 and leaves no temporary file; on failure it removes its temporary file', async () => {
    const dir = join(f.root, 'atomic');
    await writeAtomic(join(dir, 'a.json'), 'one');
    expect((await stat(join(dir, 'a.json'))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['a.json']);

    // The rename cannot replace a folder that holds a file: the failure path runs.
    await mkdir(join(dir, 'b.json'));
    await writeFile(join(dir, 'b.json', 'inside'), 'x');
    await expect(writeAtomic(join(dir, 'b.json'), 'two')).rejects.toThrow();
    expect((await readdir(dir)).sort()).toEqual(['a.json', 'b.json']);
  });
});
