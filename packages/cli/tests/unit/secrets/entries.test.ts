import { describe, it } from 'bun:test';
import {
  LOGIN_PASSWORD_MAX_LENGTH,
  LOGIN_TOTP_WARNING,
  type LoginEntryList,
  type LoginEntrySummary,
  type PutLoginEntryRequest,
  type RemovedLoginEntry,
} from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { registerSecretCommands } from '../../../src/lib/secrets/commands';
import { SecretController } from '../../../src/lib/secrets/controller';
import { registerLoginEntryCommands } from '../../../src/lib/secrets/entry-commands';
import { LoginEntryController } from '../../../src/lib/secrets/entry-controller';
import { LOGIN_ENTRIES_PATH, ProtocolLoginEntryGateway } from '../../../src/lib/secrets/entry-gateway';
import type { ILoginEntryGateway, ILoginEntryPrompt, LoginEntryPorts } from '../../../src/lib/secrets/entry-ports';
import { renderLoginEntryList } from '../../../src/lib/secrets/entry-render';

const AT = '2026-10-30T09:00:00.000Z';
const PASSWORD = 'correct-horse-UNIQUE-battery';
const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function summary(overrides: Partial<LoginEntrySummary> = {}): LoginEntrySummary {
  return {
    id: 'SUDO_KIRIN_BOX',
    label: 'sudo on kirin-box',
    match: ['sudo@kirin-box'],
    username: 'kirin',
    fields: { password: true, totp: false },
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

class FakeGateway implements ILoginEntryGateway {
  readonly calls: string[] = [];
  readonly puts: Array<{ id: string; body: PutLoginEntryRequest }> = [];
  readonly renames: Array<[string, string]> = [];
  readonly removed: string[] = [];

  constructor(private listing: LoginEntryList = { v: 1, health: 'ready', entries: [summary()] }) {}

  list(): Promise<LoginEntryList> {
    this.calls.push('list');
    return Promise.resolve(this.listing);
  }

  put(id: string, body: PutLoginEntryRequest): Promise<LoginEntrySummary> {
    this.calls.push('put');
    this.puts.push({ id, body });
    return Promise.resolve(
      summary({
        id,
        label: body.label ?? 'kept label',
        fields: { password: body.password !== undefined && body.password !== null, totp: body.totp != null },
      }),
    );
  }

  rename(id: string, to: string): Promise<LoginEntrySummary> {
    this.calls.push('rename');
    this.renames.push([id, to]);
    return Promise.resolve(summary({ id: to }));
  }

  remove(id: string): Promise<RemovedLoginEntry> {
    this.calls.push('remove');
    this.removed.push(id);
    return Promise.resolve({ id, removed: true });
  }
}

class FakePrompt implements ILoginEntryPrompt {
  readonly asked: string[] = [];
  readonly hidden: string[] = [];

  constructor(
    private readonly hiddenAnswers: string[] = [PASSWORD],
    private readonly answers: string[] = ['yes'],
  ) {}

  ask(message: string): Promise<string> {
    this.asked.push(message);
    return Promise.resolve(this.answers.shift() ?? '');
  }

  askHidden(message: string): Promise<string> {
    this.hidden.push(message);
    return Promise.resolve(this.hiddenAnswers.shift() ?? '');
  }
}

function rig(gateway = new FakeGateway(), prompt = new FakePrompt(), interactive = true) {
  const messages: string[] = [];
  const ports: LoginEntryPorts = {
    gateway,
    prompt,
    interactive,
    out: { success: message => void messages.push(message) },
  };
  return { gateway, prompt, messages, controller: new LoginEntryController(ports) };
}

const fails = async (run: () => Promise<unknown>): Promise<string> => {
  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  should(error).be.an.Error();
  return (error as Error).message;
};

describe('fy secret entry ls', () => {
  it('should list label, handle, match, username and which fields exist', async () => {
    // Arrange
    const { controller, messages } = rig(
      new FakeGateway({
        v: 1,
        health: 'ready',
        entries: [
          summary({ fields: { password: true, totp: true }, totp: { algorithm: 'SHA1', digits: 6, period: 30 } }),
        ],
      }),
    );

    // Act
    await controller.list({});

    // Assert
    const text = messages.join('\n');
    should(text).containEql('sudo on kirin-box  [SUDO_KIRIN_BOX]');
    should(text).containEql('match: sudo@kirin-box');
    should(text).containEql('username: kirin');
    should(text).containEql('fields: password ✓  2FA ✓');
  });

  it('should print the protocol document with --json', async () => {
    // Arrange
    const { controller, messages } = rig();

    // Act
    await controller.list({ json: true });

    // Assert
    should(JSON.parse(messages[0] ?? '').entries[0].id).equal('SUDO_KIRIN_BOX');
  });

  it('should render a damaged store as damaged, never as empty', () => {
    // Act
    const text = renderLoginEntryList({ v: 1, health: 'damaged', diagnosis: 'the vault key is missing', entries: [] });

    // Assert
    should(text).containEql('cannot read its secret store');
    should(text).containEql('the vault key is missing');
    should(text).containEql('NOT gone');
    should(text).not.containEql('No saved logins');
  });

  it('should say so when there are none', async () => {
    // Arrange
    const { controller, messages } = rig(new FakeGateway({ v: 1, health: 'ready', entries: [] }));

    // Act
    await controller.list({});

    // Assert
    should(messages).deepEqual(['No saved logins on this daemon.']);
  });
});

describe('fy secret entry add', () => {
  it('should read the password hidden and put it with the label, matches and username', async () => {
    // Arrange
    const { controller, gateway, prompt, messages } = rig(new FakeGateway({ v: 1, health: 'ready', entries: [] }));

    // Act
    await controller.add('SUDO_KIRIN_BOX', {
      label: ' sudo on kirin-box ',
      match: ['Sudo@Kirin-Box'],
      username: 'kirin',
    });

    // Assert
    should(prompt.hidden).have.length(1);
    should(gateway.puts).deepEqual([
      {
        id: 'SUDO_KIRIN_BOX',
        body: { label: 'sudo on kirin-box', match: ['sudo@kirin-box'], username: 'kirin', password: PASSWORD },
      },
    ]);
    should(messages[0]).startWith('Added SUDO_KIRIN_BOX');
    should(messages.join('\n')).not.containEql(PASSWORD);
  });

  it('should skip the prompt with --no-password', async () => {
    // Arrange
    const { controller, gateway, prompt } = rig(new FakeGateway({ v: 1, health: 'ready', entries: [] }));

    // Act
    await controller.add('SUDO_KIRIN_BOX', { label: 'x', password: false });

    // Assert
    should(prompt.hidden).have.length(0);
    should(gateway.puts[0]?.body.password).be.undefined();
  });

  it('should refuse an existing handle rather than overwrite it, before any prompt', async () => {
    // Arrange
    const { controller, gateway, prompt } = rig();

    // Act
    const message = await fails(() => controller.add('SUDO_KIRIN_BOX', { label: 'x' }));

    // Assert
    should(message).containEql('already exists');
    should(prompt.hidden).have.length(0);
    should(gateway.puts).have.length(0);
  });

  it('should refuse to add into a damaged store', async () => {
    // Arrange
    const { controller, gateway } = rig(new FakeGateway({ v: 1, health: 'damaged', diagnosis: 'locked', entries: [] }));

    // Act
    const message = await fails(() => controller.add('NEW_ONE', { label: 'x' }));

    // Assert
    should(message).containEql('NOT gone');
    should(gateway.puts).have.length(0);
  });

  it('should refuse a short password without repeating it, and a bad handle, match or label', async () => {
    // Arrange
    const short = 'abc';
    const fresh = () => rig(new FakeGateway({ v: 1, health: 'ready', entries: [] }), new FakePrompt([short]));

    // Act
    const password = fresh();
    const passwordMessage = await fails(() => password.controller.add('NEW_ONE', { label: 'x' }));
    const handle = await fails(() => fresh().controller.add('bad handle', { label: 'x' }));
    const match = await fails(() => fresh().controller.add('NEW_ONE', { label: 'x', match: ['not a target!'] }));
    const label = await fails(() => fresh().controller.add('NEW_ONE', { label: '   ' }));

    // Assert
    should(passwordMessage).containEql('at least');
    should(passwordMessage).not.containEql(short);
    should(password.gateway.puts).have.length(0);
    should(handle).containEql('not a usable handle');
    should(match).containEql('not something a login matches');
    should(label).containEql('--label');
  });

  it('should refuse a password too long, or one that would press keys, without repeating it', async () => {
    // Arrange
    const long = 'x'.repeat(LOGIN_PASSWORD_MAX_LENGTH + 1);
    const keys = 'correct-horse\nbattery';
    const fresh = (value: string) =>
      rig(new FakeGateway({ v: 1, health: 'ready', entries: [] }), new FakePrompt([value]));

    // Act
    const tooLong = fresh(long);
    const tooLongMessage = await fails(() => tooLong.controller.add('NEW_ONE', { label: 'x' }));
    const pressing = fresh(keys);
    const pressingMessage = await fails(() => pressing.controller.add('NEW_ONE', { label: 'x' }));

    // Assert
    should(tooLongMessage).containEql('at most');
    should(pressingMessage).containEql('would press keys');
    should(pressingMessage).not.containEql('correct-horse');
    should(tooLong.gateway.puts).have.length(0);
    should(pressing.gateway.puts).have.length(0);
  });

  it('should refuse to prompt off a terminal', async () => {
    // Arrange
    const { controller, gateway } = rig(
      new FakeGateway({ v: 1, health: 'ready', entries: [] }),
      new FakePrompt(),
      false,
    );

    // Act
    const message = await fails(() => controller.add('NEW_ONE', { label: 'x' }));

    // Assert
    should(message).containEql('needs a terminal');
    should(gateway.puts).have.length(0);
  });
});

describe('fy secret entry edit', () => {
  it('should send only the fields named: omitted is kept, --no-username is null', async () => {
    // Arrange
    const { controller, gateway, prompt } = rig();

    // Act
    await controller.edit('SUDO_KIRIN_BOX', { label: 'renamed label', match: ['sudo@other'], username: false });

    // Assert
    should(prompt.hidden).have.length(0);
    should(gateway.puts[0]?.body).deepEqual({ label: 'renamed label', match: ['sudo@other'], username: null });
  });

  it('should change the username, and the password through a hidden prompt', async () => {
    // Arrange
    const { controller, gateway, prompt } = rig(new FakeGateway(), new FakePrompt(['another-UNIQUE-pass']));

    // Act
    await controller.edit('SUDO_KIRIN_BOX', { username: 'deploy', password: true });

    // Assert
    should(prompt.hidden).have.length(1);
    should(gateway.puts[0]?.body).deepEqual({ username: 'deploy', password: 'another-UNIQUE-pass' });
  });

  it('should refuse when nothing is named, or the entry does not exist', async () => {
    // Arrange
    const { controller, gateway } = rig();

    // Act
    const nothing = await fails(() => controller.edit('SUDO_KIRIN_BOX', {}));
    const missing = await fails(() => controller.edit('NO_SUCH', { label: 'x' }));

    // Assert
    should(nothing).containEql('nothing to change');
    should(missing).containEql('no saved login NO_SUCH');
    should(gateway.puts).have.length(0);
  });

  it('should print the warning, require a typed yes, then send the seed with the acknowledgement', async () => {
    // Arrange
    const { controller, gateway, prompt, messages } = rig(new FakeGateway(), new FakePrompt([SEED], ['yes']));

    // Act
    await controller.edit('SUDO_KIRIN_BOX', { totp: true });

    // Assert
    should(messages[0]).containEql(LOGIN_TOTP_WARNING);
    should(prompt.asked).have.length(1);
    should(gateway.puts[0]?.body).deepEqual({ totp: { seed: SEED }, totpAcknowledged: true });
  });

  it('should keep no seed when the owner does not type yes, and ask for no seed', async () => {
    // Arrange
    const { controller, gateway, prompt } = rig(new FakeGateway(), new FakePrompt([SEED], ['no']));

    // Act
    const message = await fails(() => controller.edit('SUDO_KIRIN_BOX', { totp: true }));

    // Assert
    should(message).containEql('nothing was changed');
    should(prompt.hidden).have.length(0);
    should(gateway.puts).have.length(0);
  });

  it('should skip the typed yes with --i-understand-totp, but still show the warning', async () => {
    // Arrange
    const { controller, gateway, prompt, messages } = rig(new FakeGateway(), new FakePrompt([SEED]));

    // Act
    await controller.edit('SUDO_KIRIN_BOX', { totp: true, iUnderstandTotp: true });

    // Assert
    should(prompt.asked).have.length(0);
    should(messages[0]).containEql(LOGIN_TOTP_WARNING);
    should(gateway.puts[0]?.body.totpAcknowledged).equal(true);
  });

  it('should refuse a bad seed without repeating it', async () => {
    // Arrange
    const bad = 'not-a-seed-UNIQUE!';
    const { controller, gateway } = rig(new FakeGateway(), new FakePrompt([bad]));

    // Act
    const message = await fails(() => controller.edit('SUDO_KIRIN_BOX', { totp: true }));

    // Assert
    should(message).containEql('base32');
    should(message).not.containEql(bad);
    should(gateway.puts).have.length(0);
  });

  it('should forget the seed with --no-totp, with no prompt and no warning', async () => {
    // Arrange
    const { controller, gateway, prompt, messages } = rig();

    // Act
    await controller.edit('SUDO_KIRIN_BOX', { totp: false });

    // Assert
    should(gateway.puts[0]?.body).deepEqual({ totp: null });
    should(prompt.hidden).have.length(0);
    should(messages.join('\n')).not.containEql(LOGIN_TOTP_WARNING);
  });
});

describe('fy secret entry rename and rm', () => {
  it('should rename through the gateway', async () => {
    // Arrange
    const { controller, gateway, messages } = rig();

    // Act
    await controller.rename('SUDO_KIRIN_BOX', 'SUDO_BOX');

    // Assert
    should(gateway.renames).deepEqual([['SUDO_KIRIN_BOX', 'SUDO_BOX']]);
    should(messages).deepEqual(['Renamed SUDO_KIRIN_BOX to SUDO_BOX.']);
  });

  it('should refuse a bad new handle before calling the daemon', async () => {
    // Arrange
    const { controller, gateway } = rig();

    // Act
    const message = await fails(() => controller.rename('SUDO_KIRIN_BOX', 'lowercase'));

    // Assert
    should(message).containEql('not a usable handle');
    should(gateway.renames).have.length(0);
  });

  it('should ask before removing, and remove on yes', async () => {
    // Arrange
    const { controller, gateway, prompt } = rig(new FakeGateway(), new FakePrompt([], ['yes']));

    // Act
    await controller.remove('SUDO_KIRIN_BOX', {});

    // Assert
    should(prompt.asked[0]).containEql('sudo on kirin-box');
    should(gateway.removed).deepEqual(['SUDO_KIRIN_BOX']);
  });

  it('should keep the entry on anything but yes', async () => {
    // Arrange
    const { controller, gateway, messages } = rig(new FakeGateway(), new FakePrompt([], ['n']));

    // Act
    await controller.remove('SUDO_KIRIN_BOX', {});

    // Assert
    should(gateway.removed).have.length(0);
    should(messages).deepEqual(['Kept SUDO_KIRIN_BOX.']);
  });

  it('should not ask with --yes, even off a terminal', async () => {
    // Arrange
    const { controller, gateway, prompt } = rig(new FakeGateway(), new FakePrompt(), false);

    // Act
    await controller.remove('SUDO_KIRIN_BOX', { yes: true });

    // Assert
    should(prompt.asked).have.length(0);
    should(gateway.removed).deepEqual(['SUDO_KIRIN_BOX']);
  });

  it('should refuse off a terminal without --yes, and when the entry does not exist', async () => {
    // Arrange
    const off = rig(new FakeGateway(), new FakePrompt(), false);
    const { controller } = rig();

    // Act
    const noTerminal = await fails(() => off.controller.remove('SUDO_KIRIN_BOX', {}));
    const missing = await fails(() => controller.remove('NO_SUCH', { yes: true }));

    // Assert
    should(noTerminal).containEql('--yes');
    should(off.gateway.removed).have.length(0);
    should(missing).containEql('no saved login NO_SUCH');
  });
});

describe('fy secret entry commands', () => {
  function program(harness = rig()) {
    const root = new Command().name('fy').exitOverride();
    root.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerSecretCommands(
      root,
      new SecretController(
        {
          list: () => Promise.reject(new Error('unused')),
          put: () => Promise.reject(new Error('unused')),
          remove: () => Promise.reject(new Error('unused')),
          use: () => Promise.reject(new Error('unused')),
        },
        { success: () => {}, error: () => {}, setExitCode: () => {}, raw: () => {} },
        { read: () => Promise.reject(new Error('unused')) },
      ),
      harness.controller,
    );
    return { root, ...harness };
  }

  it('should parse every spelling the brief names', async () => {
    // Arrange
    const add = program(rig(new FakeGateway({ v: 1, health: 'ready', entries: [] })));
    const edit = program();
    const none = program();
    const rename = program();
    const rm = program();
    const ls = program();

    // Act
    await add.root.parseAsync([
      'node',
      'fy',
      'secret',
      'entry',
      'add',
      'NEW_ONE',
      '--label',
      'New',
      '--match',
      'a.example',
      '--match',
      'b.example',
      '--username',
      'kim',
    ]);
    await edit.root.parseAsync([
      'node',
      'fy',
      'secret',
      'entry',
      'edit',
      'SUDO_KIRIN_BOX',
      '--label',
      'L',
      '--match',
      'x.example',
      '--username',
      'kim',
    ]);
    await none.root.parseAsync([
      'node',
      'fy',
      'secret',
      'entry',
      'edit',
      'SUDO_KIRIN_BOX',
      '--no-username',
      '--no-totp',
    ]);
    await rename.root.parseAsync(['node', 'fy', 'secret', 'entry', 'rename', 'SUDO_KIRIN_BOX', 'NEWER']);
    await rm.root.parseAsync(['node', 'fy', 'secret', 'entry', 'rm', 'SUDO_KIRIN_BOX', '--yes']);
    await ls.root.parseAsync(['node', 'fy', 'secret', 'entry', 'ls', '--json']);

    // Assert
    should(add.gateway.puts[0]?.body.match).deepEqual(['a.example', 'b.example']);
    should(edit.gateway.puts[0]?.body).deepEqual({ label: 'L', match: ['x.example'], username: 'kim' });
    should(none.gateway.puts[0]?.body).deepEqual({ username: null, totp: null });
    should(rename.gateway.renames).deepEqual([['SUDO_KIRIN_BOX', 'NEWER']]);
    should(rm.gateway.removed).deepEqual(['SUDO_KIRIN_BOX']);
    should(JSON.parse(ls.messages[0] ?? '').health).equal('ready');
  });

  it('should refuse a value as a flag or argument, and no option takes one', async () => {
    // Arrange
    const { root, gateway } = program();
    const withFlag = program(rig(new FakeGateway({ v: 1, health: 'ready', entries: [] })));
    const entry = root.commands
      .find(command => command.name() === 'secret')
      ?.commands.find(command => command.name() === 'entry');

    // Act
    const argument = await root
      .parseAsync(['node', 'fy', 'secret', 'entry', 'edit', 'SUDO_KIRIN_BOX', '--password', PASSWORD])
      .catch((error: unknown) => error);
    const seed = await root
      .parseAsync(['node', 'fy', 'secret', 'entry', 'edit', 'SUDO_KIRIN_BOX', '--totp', SEED])
      .catch((error: unknown) => error);
    const flag = await withFlag.root
      .parseAsync(['node', 'fy', 'secret', 'entry', 'add', 'NEW_ONE', '--label', 'x', '--password-value', PASSWORD])
      .catch((error: unknown) => error);

    // Assert
    should(argument).be.an.Error();
    should(seed).be.an.Error();
    should(flag).be.an.Error();
    should(gateway.puts).have.length(0);
    should(withFlag.gateway.puts).have.length(0);
    const takesValue = (entry?.commands ?? [])
      .flatMap(command => command.options)
      .filter(option => option.required || option.optional)
      .map(option => option.long);
    for (const long of takesValue) should(['--label', '--match', '--username']).containEql(long);
  });
});

describe('a typed value never leaves except in the put body', () => {
  it('should keep the password and the seed out of every output, error and gateway call but the PUT', async () => {
    // Arrange
    const gateway = new FakeGateway({ v: 1, health: 'ready', entries: [summary()] });
    const prompt = new FakePrompt([PASSWORD, SEED], ['yes']);
    const { controller, messages } = rig(gateway, prompt);
    const root = new Command().name('fy').exitOverride();
    root.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerLoginEntryCommands(root.command('secret'), controller);
    const argv = [
      'node',
      'fy',
      'secret',
      'entry',
      'edit',
      'SUDO_KIRIN_BOX',
      '--password',
      '--totp',
      '--label',
      'new label',
    ];

    // Act
    await root.parseAsync(argv);
    await controller.list({});
    await controller.list({ json: true });

    // Assert
    const everything = [...messages, ...prompt.asked, ...prompt.hidden, ...argv, ...gateway.calls].join('\n');
    for (const secret of [PASSWORD, SEED]) should(everything).not.containEql(secret);
    should(JSON.stringify([gateway.renames, gateway.removed])).not.containEql(PASSWORD);
    should(gateway.puts).have.length(1);
    should(JSON.stringify(gateway.puts[0]?.body)).containEql(PASSWORD);
    should(JSON.stringify(gateway.puts[0]?.body)).containEql(SEED);
  });
});

describe('ProtocolLoginEntryGateway', () => {
  interface Seen {
    path: string;
    init?: { method?: string; body?: string };
  }

  function gatewayOver(reply: unknown) {
    const seen: Seen[] = [];
    const client = {
      request: (path: string, schema: { parse(value: unknown): unknown }, init?: Seen['init']) => {
        seen.push({ path, ...(init === undefined ? {} : { init }) });
        return Promise.resolve(schema.parse(reply));
      },
    };
    return { seen, gateway: new ProtocolLoginEntryGateway(client as never) };
  }

  it('should speak the four routes', async () => {
    // Arrange
    const list = gatewayOver({ v: 1, health: 'ready', entries: [summary()] });
    const put = gatewayOver(summary());
    const rename = gatewayOver(summary({ id: 'NEWER' }));
    const remove = gatewayOver({ id: 'SUDO_KIRIN_BOX', removed: true });

    // Act
    await list.gateway.list();
    await put.gateway.put('SUDO_KIRIN_BOX', { label: 'x', password: PASSWORD });
    await rename.gateway.rename('SUDO_KIRIN_BOX', 'NEWER');
    await remove.gateway.remove('SUDO_KIRIN_BOX');

    // Assert
    should(list.seen[0]?.path).equal(LOGIN_ENTRIES_PATH);
    should(put.seen[0]?.path).equal(`${LOGIN_ENTRIES_PATH}/SUDO_KIRIN_BOX`);
    should(put.seen[0]?.init?.method).equal('PUT');
    should(JSON.parse(put.seen[0]?.init?.body ?? '')).deepEqual({ label: 'x', password: PASSWORD });
    should(rename.seen[0]?.path).equal(`${LOGIN_ENTRIES_PATH}/SUDO_KIRIN_BOX/rename`);
    should(JSON.parse(rename.seen[0]?.init?.body ?? '')).deepEqual({ to: 'NEWER' });
    should(remove.seen[0]?.init?.method).equal('DELETE');
  });

  it('should normalise a seed and refuse one without the acknowledgement', async () => {
    // Arrange
    const { gateway, seen } = gatewayOver(summary());

    // Act
    await gateway.put('SUDO_KIRIN_BOX', {
      totp: { seed: 'jbsw y3dp ehpk 3pxp-jbsw y3dp ehpk 3pxp' },
      totpAcknowledged: true,
    });
    const refused = await gateway.put('SUDO_KIRIN_BOX', { totp: { seed: SEED } }).catch((error: unknown) => error);

    // Assert
    should(JSON.parse(seen[0]?.init?.body ?? '').totp.seed).equal(SEED);
    should(refused).be.an.Error();
    should(seen).have.length(1);
  });
});
