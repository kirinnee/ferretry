import { describe, it } from 'bun:test';
import {
  type Admission,
  type AdmissionDecision,
  type ApiRequest,
  type CallStanding,
  type ChildEnvironment,
  finalised,
  headersFrom,
  jsonResponse,
  type PluginId,
  queryFrom,
  type TargetKind,
  WITHHELD_SENTENCE,
} from '@ferretry/kernel/contract';
import { Dispatcher, localArrival, type MountedRoute } from '@ferretry/kernel/host';
import should from 'should';
import { SecretNameSchema } from '../../../../contract/index.ts';
import {
  ChildEnvironments,
  CloneableSecretNameSchema,
  HoldRegistry,
  maskGrid,
  maskLines,
  SecretDirectory,
  SecretStoreError,
  VaultRedaction,
} from '../../../../daemon/lib/secrets/index.ts';

/**
 * The parts vault-a added around today's code: the kernel-bound `Redaction` (today's `SecretRedactor.batch` as one
 * read-scoped redactor), the `ChildEnvironment` handle table (lead decision 9) and the `OutputGuard` registry.
 */

const TOKEN = 'sk-live-0123456789';

/** A value source that counts its opens, or fails. */
function source(entries: Record<string, string> | Error) {
  let opens = 0;
  return {
    opens: () => opens,
    values: async () => {
      opens += 1;
      if (entries instanceof Error) throw entries;
      return new Map(Object.entries(entries));
    },
  };
}

describe('the read-scoped redaction', () => {
  it('S15 S18 an operator read is masked: a known value reads as [redacted:NAME]', async () => {
    // Arrange
    const redaction = new VaultRedaction(source({ TOKEN }));

    // Act
    const text = await redaction.read(scope => scope.text(`export TOKEN=${TOKEN}`));

    // Assert
    should(text).equal('export TOKEN=[redacted:TOKEN]');
  });

  it('S19 a vault that cannot be opened refuses the read rather than serve unmasked text', async () => {
    // Arrange
    const redaction = new VaultRedaction(source(new SecretStoreError('key_missing', 'gone')));
    let ran = false;

    // Act / Assert
    await redaction
      .read(scope => {
        ran = true;
        return scope.text(TOKEN);
      })
      .then(
        () => should.fail('', '', 'a damaged vault must refuse the read'),
        (error: unknown) => should((error as SecretStoreError).failure).equal('key_missing'),
      );
    should(ran).be.false();
  });

  it('S20 one read opens the vault once, and its scope is revoked when the read returns', async () => {
    // Arrange
    const values = source({ TOKEN });
    const redaction = new VaultRedaction(values);
    let kept: ((s: string) => string) | undefined;

    // Act
    const texts = await redaction.read(scope => {
      kept = scope.text;
      return [scope.text(TOKEN), scope.text(`a ${TOKEN}`), scope.text('nothing')];
    });

    // Assert — nothing is cached between reads, and a scope that escaped holds nothing.
    should(values.opens()).equal(1);
    should(texts).deepEqual(['[redacted:TOKEN]', 'a [redacted:TOKEN]', 'nothing']);
    should(() => kept?.(TOKEN)).throw();
  });

  it('should mask cells with same-width stars, including a value wrapped across rows', async () => {
    // Arrange — the token's first 8 characters end row one and the rest start row two.
    const grid = {
      columns: 12,
      rows: [[...`abcd${TOKEN.slice(0, 8)}`], [...`${TOKEN.slice(8)}x`]],
    };

    // Act
    const masked = maskGrid(grid, [TOKEN]);

    // Assert — the shape is untouched and only the matched cells changed.
    should(masked.columns).equal(12);
    should(masked.rows[0]?.join('')).equal('abcd********');
    should(masked.rows[1]?.join('')).equal(`${'*'.repeat(TOKEN.length - 8)}x`);
  });

  it('should mask lines keeping each length, across a wrap', () => {
    const lines = maskLines([`one ${TOKEN.slice(0, 5)}`, `${TOKEN.slice(5)} two`], [TOKEN]);
    should(lines).deepEqual([`one ${'*'.repeat(5)}`, `${'*'.repeat(TOKEN.length - 5)} two`]);
  });
});

describe('child environments (lead decision 9)', () => {
  it('S5 a handle opens once to the values it was minted with, and says only its variable names', () => {
    // Arrange
    const table = new ChildEnvironments();
    const handle = table.mint({ TOKEN, PATH: '/usr/bin' });

    // Act
    const first = table.open(handle);
    const second = table.open(handle);

    // Assert — the values reach the kernel's spawn once and are never in the handle's JSON or fields.
    should(first).deepEqual({ TOKEN, PATH: '/usr/bin' });
    should(second).be.undefined();
    should(handle.names).deepEqual(['PATH', 'TOKEN']);
    should(JSON.stringify(handle)).not.containEql(TOKEN);
  });

  it('should refuse to open a handle another table minted, or a forged one', () => {
    const table = new ChildEnvironments();
    const other = new ChildEnvironments().mint({ TOKEN });
    should(table.open(other)).be.undefined();
    should(table.open({ names: ['TOKEN'] } as unknown as ChildEnvironment)).be.undefined();
  });
});

describe('what the types refuse', () => {
  it('S6 S157 the management surface has no method that hands back a value', () => {
    // Assert — the directory a route holds can list, write and remove; nothing on it opens ciphertext.
    const methods = Object.getOwnPropertyNames(SecretDirectory.prototype).filter(name => name !== 'constructor');
    should(methods.filter(name => !name.startsWith('#')).sort()).deepEqual(
      ['document', 'inTurn', 'list', 'put', 'putIf', 'putMissing', 'remove', 'write'].sort(),
    );
  });

  it('S7 only the allowlisted holders are given a SecretVault, all of them in the composition root', async () => {
    // Arrange — the package's own source (never its tests), comments stripped so prose cannot hide or fake a use.
    const root = new URL('../../../../', import.meta.url).pathname;
    const sources = new Map<string, string>();
    for await (const path of new Bun.Glob('{contract,daemon,app,cli}/**/*.ts').scan({ cwd: root })) {
      const text = await Bun.file(`${root}${path}`).text();
      sources.set(path, text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, ''));
    }
    sources.set('manifest.ts', await Bun.file(`${root}manifest.ts`).text());

    // Act
    const constructs = [...sources].filter(([, text]) => /new\s+SecretVault\s*\(/u.test(text)).map(([path]) => path);
    const importers = [...sources]
      .filter(
        ([path, text]) => path !== 'daemon/lib/secrets/vault.ts' && /import[^;]*\bSecretVault\b[^;]*from/u.test(text),
      )
      .map(([path]) => path)
      .sort();
    const composition = sources.get('daemon/index.ts') ?? '';
    // Every place the composition root's vault binding is handed on or opened, keys like `vault: api` aside.
    const uses = [...composition.matchAll(/(?<![.\w'"/-])vault(?![\w-])(?!\s*:)/gu)].length - 1; // minus its declaration
    const holders = {
      redactor: /combinedValues\(\s*vault\b/u,
      'use executor': /new\s+SecretUseService\(\s*vault\b/u,
      'outbound provider authorizer': /new\s+OutboundProviderAuthorizer\(\s*vault\b/u,
      'secret export': /new\s+SecretExportService\(\{[^}]*\bvault\b[^}]*\}\)/u,
      'ferret launch environment': /childEnvironment\s*=\s*async[\s\S]*?\bvault\.values\(\)/u,
    };

    // Assert — one vault, built in one place, handed only to the allowlist. A new holder adds a use and fails here.
    should(constructs).deepEqual(['daemon/index.ts']);
    should(importers).deepEqual(['daemon/index.ts', 'daemon/lib/secrets/clone.ts', 'daemon/lib/secrets/use.ts']);
    for (const [holder, pattern] of Object.entries(holders)) should(pattern.test(composition)).be.true(holder);
    should(uses).equal(Object.keys(holders).length);
    // The routes are handed the directory and the services, never the vault itself.
    should(composition).match(/secretRouteHandlers\(\{\s*directory,\s*references:[^}]*\}\)/u);
    should(/secretRouteHandlers\(\{[^}]*\bvault\b/u.test(composition)).be.false();
  });

  it('S12 S62 `${secret:…}` names only a stored secret: an account seal key is not a secret name', () => {
    should(SecretNameSchema.safeParse('login:GITHUB:password').success).be.false();
    should(SecretNameSchema.safeParse('GITHUB_TOKEN').success).be.true();
  });

  it("S143 S144 S145 a copy's names cannot hold an MCP sign-in token", () => {
    should(CloneableSecretNameSchema.safeParse('MCP_LINEAR_0123456789ABCDEF_ACCESS').success).be.false();
    should(CloneableSecretNameSchema.safeParse('OPENAI_API_KEY').success).be.true();
  });
});

describe('the output guard', () => {
  const pane = { kind: 'terminal' as TargetKind, key: 'dev' };
  const other = { kind: 'terminal' as TargetKind, key: 'app' };

  it('should withhold a body stamped before a hold began on its target, and only on its target', () => {
    // Arrange
    const guard = new HoldRegistry();
    const stamped = guard.stamp([pane]);
    const elsewhere = guard.stamp([other]);

    // Act
    guard.moved(pane);

    // Assert
    should(guard.stillShowable(stamped)).be.false();
    should(guard.stillShowable(elsewhere)).be.true();
    should(guard.stillShowable(guard.stamp([pane]))).be.true();
  });

  it('should read a stamp it cannot check as not showable', () => {
    const guard = new HoldRegistry();
    should(guard.stillShowable({ generation: 0, targets: null as never })).be.false();
  });

  it('I74 an unscoped stamp is withheld once any hold changed after it', () => {
    // Arrange — the kernel dispatcher stamps without targets: it does not know what the handler will read.
    const guard = new HoldRegistry();
    const unscoped = guard.stamp();

    // Act
    guard.moved(other);

    // Assert — an empty target list is not "nothing to check".
    should(guard.stillShowable(unscoped)).be.false();
    should(guard.stillShowable(guard.stamp())).be.true();
  });

  it('I74 through the real kernel Dispatcher, a hold that began after a guarded body was built withholds it', async () => {
    // Arrange — a `guard: 'secrets'` route mounted on the kernel's own dispatcher, bound to this HoldRegistry.
    const guard = new HoldRegistry();
    const admitted: AdmissionDecision = {
      outcome: 'admitted',
      standing: {} as CallStanding,
      actor: 'owner-tools',
    };
    const admission = {
      admit: () => admitted,
      admitMember: () => admitted,
      readmit: () => true,
      inventory: (_request: unknown, entries: unknown) => entries,
    } as unknown as Admission;
    const route: MountedRoute = {
      method: 'GET',
      path: '/v1/pane',
      minimum: 'authenticated',
      caller: 'any',
      audit: { skip: 'test' },
      guard: 'secrets',
      owner: { plugin: 'terminals' as PluginId, title: 'Terminals', serving: () => ({ kind: 'serving' }) },
      handle: async () => jsonResponse({ text: 'export TOKEN=[redacted:TOKEN] and the old pane' }),
    };
    const dispatcher = new Dispatcher(
      { admission: () => admission, outputGuard: () => guard, version: '5.0.0' },
      { routes: [route], sockets: [], memberRoutes: [] },
    );
    const call = (): ApiRequest => ({
      method: 'GET',
      path: '/v1/pane',
      query: queryFrom([]),
      headers: headersFrom({}),
      arrival: localArrival(false),
      text: async () => '',
    });

    // Act — one response finalised with nothing changed, one after a hold began on a terminal.
    const untouched = finalised(await dispatcher.dispatch(call()));
    const response = await dispatcher.dispatch(call());
    guard.moved(pane);
    const last = finalised(response);

    // Assert — the late check chose the withheld sentence, not the body built before the hold.
    should(untouched.status).equal(200);
    should(untouched.body).containEql('the old pane');
    should(last.status).equal(409);
    should(last.body).containEql(WITHHELD_SENTENCE);
    should(last.body).not.containEql('the old pane');
  });
});
