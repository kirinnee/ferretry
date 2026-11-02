import { describe, it } from 'bun:test';
import type { InputRequest, InputSaved } from '@ferretry/protocol';
import { unpadInputValue } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { registerInputCommands } from '../../../src/lib/input/commands';
import { InputController } from '../../../src/lib/input/controller';
import { renderInputList } from '../../../src/lib/input/render';
import { DIGEST, FakeHiddenPrompt, FakeInputGateway, request, rig, SESSION, VALUE } from './fixtures';

const options = { session: SESSION };
const NOW = Date.parse('2026-10-30T09:02:00.000Z');

const SAVED: InputSaved = {
  match: 'sudo@kirin-box',
  suggest: { id: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box' },
  saves: 'password',
  offers: [
    { id: 'OTHER_BOX', label: 'other box', fills: 'password', matched: false },
    { id: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box', username: 'kirin', fills: 'password', matched: true },
  ],
};

function withSaved(saved: InputSaved | undefined = SAVED): InputRequest {
  return request(saved === undefined ? {} : { saved });
}

function rigWith(saved?: InputSaved, result = {}, overrides = {}, prompt = new FakeHiddenPrompt()) {
  return rig(overrides, new FakeInputGateway([withSaved(saved)], result), prompt);
}

describe('fy input answer --secret', () => {
  it('should send only the entry name: no prompt, no padded value', async () => {
    // Arrange
    const { ports, gateway, prompt, out } = rigWith();

    // Act
    await new InputController(ports).answer('!A7', { ...options, secret: 'SUDO_KIRIN_BOX' });

    // Assert
    should(prompt.asked).have.length(0);
    should(gateway.delivered).have.length(1);
    should(gateway.delivered[0]?.body).deepEqual({
      deliveryId: gateway.delivered[0]?.body.deliveryId,
      observedDigest: DIGEST,
      entry: 'SUDO_KIRIN_BOX',
      submit: true,
    });
    should(out.messages).deepEqual(['Sent to %terminal:dev and pressed Enter.']);
  });

  it('should take --entry as the same flag, and refuse two different names', async () => {
    // Arrange
    const first = rigWith();
    const second = rigWith();

    // Act
    await new InputController(first.ports).answer('!A7', { ...options, entry: 'SUDO_KIRIN_BOX' });
    const failure = await new InputController(second.ports)
      .answer('!A7', { ...options, secret: 'A_ONE', entry: 'A_TWO' })
      .catch((error: unknown) => error);

    // Assert
    should(first.gateway.delivered[0]?.body.entry).equal('SUDO_KIRIN_BOX');
    should((failure as Error).message).containEql('same flag');
    should(second.gateway.delivered).have.length(0);
  });

  it('should take --account as the flag, the same name in an old spelling too, and refuse two different names', async () => {
    // Arrange
    const first = rigWith();
    const second = rigWith();
    const third = rigWith();

    // Act
    await new InputController(first.ports).answer('!A7', { ...options, account: 'SUDO_KIRIN_BOX' });
    await new InputController(second.ports).answer('!A7', {
      ...options,
      account: 'SUDO_KIRIN_BOX',
      secret: 'SUDO_KIRIN_BOX',
    });
    const failure = await new InputController(third.ports)
      .answer('!A7', { ...options, account: 'A_ONE', secret: 'A_TWO' })
      .catch((error: unknown) => error);

    // Assert
    should(first.gateway.delivered[0]?.body.entry).equal('SUDO_KIRIN_BOX');
    should(second.gateway.delivered[0]?.body.entry).equal('SUDO_KIRIN_BOX');
    should((failure as Error).message).equal('--account, --secret and --entry are the same flag: name one account');
    should(third.gateway.delivered).have.length(0);
  });

  it('should work without a terminal, because no value is typed', async () => {
    // Arrange
    const { ports, gateway } = rigWith(undefined, {}, { interactive: false });

    // Act
    await new InputController(ports).answer('!A7', { ...options, secret: 'SUDO_KIRIN_BOX' });

    // Assert
    should(gateway.delivered).have.length(1);
  });

  it('should refuse a name that is not a handle, and send nothing', async () => {
    // Arrange
    const { ports, gateway } = rigWith();

    // Act
    const failure = await new InputController(ports)
      .answer('!A7', { ...options, secret: 'not a handle' })
      .catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).containEql("is not an account's handle");
    should(gateway.delivered).have.length(0);
  });

  it('should still refuse inside a ferret’s pane', async () => {
    // Arrange
    const { ports, gateway } = rigWith(undefined, {}, { ownSessionId: 'mvgt2oz9-04e28935' });

    // Act
    const failure = await new InputController(ports)
      .answer('!A7', { ...options, secret: 'SUDO_KIRIN_BOX' })
      .catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).containEql("a ferret's pane can't run it");
    should(gateway.listed).have.length(0);
    should(gateway.delivered).have.length(0);
  });

  it('should refuse combining it with --save-as or --label', async () => {
    // Arrange
    const { ports, gateway } = rigWith();
    const controller = new InputController(ports);

    // Act
    const saveAs = await controller
      .answer('!A7', { ...options, secret: 'SUDO_KIRIN_BOX', saveAs: 'ANOTHER' })
      .catch((error: unknown) => error);
    const label = await controller
      .answer('!A7', { ...options, secret: 'SUDO_KIRIN_BOX', label: 'x' })
      .catch((error: unknown) => error);

    // Assert
    should((saveAs as Error).message).containEql('cannot be combined');
    should(label).be.an.Error();
    should(gateway.delivered).have.length(0);
  });

  it('should tell the owner which saved login matched before they choose', async () => {
    // Arrange
    const { ports, out } = rigWith();

    // Act
    await new InputController(ports).answer('!A7', { ...options, secret: 'SUDO_KIRIN_BOX' });

    // Assert
    should(out.diagnostics.join('\n')).containEql(
      'an account matches: SUDO_KIRIN_BOX (sudo on kirin-box) (answer with --account SUDO_KIRIN_BOX)',
    );
  });
});

describe('fy input answer --save-as', () => {
  it('should send the typed value padded with the save, using the card’s suggested label', async () => {
    // Arrange
    const { ports, gateway, out } = rigWith(SAVED, { saved: { entry: 'SUDO_KIRIN_BOX', ok: true } });

    // Act
    await new InputController(ports).answer('!A7', { ...options, saveAs: 'SUDO_KIRIN_BOX' });

    // Assert
    const body = gateway.delivered[0]?.body;
    should(unpadInputValue(body?.padded ?? '')).equal(VALUE);
    should(body?.save).deepEqual({ entry: 'SUDO_KIRIN_BOX', label: 'sudo on kirin-box' });
    should(out.messages).deepEqual(['Sent to %terminal:dev and pressed Enter.', 'Saved as SUDO_KIRIN_BOX.']);
  });

  it('should use --label when given', async () => {
    // Arrange
    const { ports, gateway } = rigWith();

    // Act
    await new InputController(ports).answer('!A7', { ...options, saveAs: 'NEW_ONE', label: '  My box  ' });

    // Assert
    should(gateway.delivered[0]?.body.save).deepEqual({ entry: 'NEW_ONE', label: 'My box' });
  });

  it('should fall back to the handle for the label of an unknown entry', async () => {
    // Arrange
    const { ports, gateway } = rigWith();

    // Act
    await new InputController(ports).answer('!A7', { ...options, saveAs: 'NEW_ONE' });

    // Assert
    should(gateway.delivered[0]?.body.save?.label).equal('NEW_ONE');
  });

  it('should say what went wrong when the daemon could not save, and that it was typed anyway', async () => {
    // Arrange
    const { ports, out } = rigWith(SAVED, { saved: { entry: 'NEW_ONE', ok: false, problem: 'the store is full' } });

    // Act
    await new InputController(ports).answer('!A7', { ...options, saveAs: 'NEW_ONE' });

    // Assert
    should(out.messages[1]).containEql('Not saved as NEW_ONE: the store is full');
    should(out.messages[1]).containEql('typed all the same');
  });

  it('should refuse when the request does not offer saving, before asking for the value', async () => {
    // Arrange
    const { ports, gateway, prompt } = rigWith({ offers: [] });
    const none = rig({}, new FakeInputGateway([request()]));

    // Act
    const failure = await new InputController(ports)
      .answer('!A7', { ...options, saveAs: 'NEW_ONE' })
      .catch((error: unknown) => error);
    const missing = await new InputController(none.ports)
      .answer('!A7', { ...options, saveAs: 'NEW_ONE' })
      .catch((error: unknown) => error);

    // Assert
    should((failure as Error).message).containEql('cannot be saved');
    should((missing as Error).message).containEql('cannot be saved');
    should(prompt.asked).have.length(0);
    should(gateway.delivered).have.length(0);
    should(none.gateway.delivered).have.length(0);
  });

  it('should refuse a too-short password BEFORE sending, and say it can still be sent unsaved', async () => {
    // Arrange
    const short = 'abc';
    const { ports, gateway, out } = rigWith(SAVED, {}, {}, new FakeHiddenPrompt(short));

    // Act
    const failure = await new InputController(ports)
      .answer('!A7', { ...options, saveAs: 'NEW_ONE' })
      .catch((error: unknown) => error);

    // Assert
    const message = (failure as Error).message;
    should(message).containEql('cannot be saved');
    should(message).containEql('without --save-as to send it unsaved');
    should(message).not.containEql(short);
    should(gateway.delivered).have.length(0);
    should(out.all()).not.containEql(short);
  });

  it('should send the same short value unsaved without --save-as', async () => {
    // Arrange
    const { ports, gateway } = rigWith(SAVED, {}, {}, new FakeHiddenPrompt('abc'));

    // Act
    await new InputController(ports).answer('!A7', options);

    // Assert
    should(gateway.delivered).have.length(1);
    should(gateway.delivered[0]?.body.save).be.undefined();
  });

  it('should not apply the password minimum to a plain value saved as a username', async () => {
    // Arrange
    const saved: InputSaved = { saves: 'username', offers: [] };
    const gateway = new FakeInputGateway([request({ sensitivity: 'plain', saved })]);
    const { ports } = rig({}, gateway, new FakeHiddenPrompt('kim'));

    // Act
    await new InputController(ports).answer('!A7', { ...options, saveAs: 'KIM_NAME' });

    // Assert
    should(gateway.delivered[0]?.body.save?.entry).equal('KIM_NAME');
  });

  it('should refuse --label without --save-as, and an over-long label', async () => {
    // Arrange
    const { ports, gateway } = rigWith();
    const controller = new InputController(ports);

    // Act
    const lone = await controller.answer('!A7', { ...options, label: 'x' }).catch((error: unknown) => error);
    const long = await controller
      .answer('!A7', { ...options, saveAs: 'NEW_ONE', label: 'x'.repeat(81) })
      .catch((error: unknown) => error);

    // Assert
    should((lone as Error).message).containEql('goes with --save-as');
    should((long as Error).message).containEql('--label');
    should(gateway.delivered).have.length(0);
  });

  it('should never print the typed value, in text or JSON', async () => {
    // Arrange
    const text = rigWith(SAVED, { saved: { entry: 'NEW_ONE', ok: true } });
    const json = rigWith(SAVED, { saved: { entry: 'NEW_ONE', ok: true } });

    // Act
    await new InputController(text.ports).answer('!A7', { ...options, saveAs: 'NEW_ONE' });
    await new InputController(json.ports).answer('!A7', { ...options, saveAs: 'NEW_ONE', json: true });

    // Assert
    should(text.out.all()).not.containEql(VALUE);
    should(json.out.all()).not.containEql(VALUE);
  });
});

describe('fy input ls', () => {
  it('should show the matched saved login by handle and label, and nothing more', () => {
    // Arrange
    const list = { requests: [withSaved()] };

    // Act
    const text = renderInputList(list, NOW);

    // Assert
    should(text).containEql('use: SUDO_KIRIN_BOX (sudo on kirin-box)');
    should(text).not.containEql('kirin\n');
    should(text).not.containEql('OTHER_BOX');
  });

  it('should show nothing extra when no offer matched or the request carries none', () => {
    // Arrange
    const unmatched = request({
      saved: { offers: [{ id: 'A_ONE', label: 'one', fills: 'password', matched: false }] },
    });

    // Act
    const text = renderInputList({ requests: [unmatched, request()] }, NOW);

    // Assert
    should(text).not.containEql('use:');
  });
});

describe('fy input commands (saved logins)', () => {
  function run(argv: string[], saved: InputSaved = SAVED) {
    const harness = rig({}, new FakeInputGateway([withSaved(saved)]));
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerInputCommands(program, new InputController(harness.ports));
    return { ...harness, parsed: program.parseAsync(['node', 'fy', ...argv]) };
  }

  it('should parse --account NAME, its old spellings --secret and --entry, and --save-as NAME --label TEXT', async () => {
    // Arrange
    const account = run(['input', 'answer', '!A7', '-s', SESSION, '--account', 'SUDO_KIRIN_BOX']);
    const secret = run(['input', 'answer', '!A7', '-s', SESSION, '--secret', 'SUDO_KIRIN_BOX']);
    const entry = run(['input', 'answer', '!A7', '-s', SESSION, '--entry', 'SUDO_KIRIN_BOX']);
    const save = run(['input', 'answer', '!A7', '-s', SESSION, '--save-as', 'NEW_ONE', '--label', 'My box']);

    // Act
    await Promise.all([account.parsed, secret.parsed, entry.parsed, save.parsed]);

    // Assert
    should(account.gateway.delivered[0]?.body.entry).equal('SUDO_KIRIN_BOX');
    should(secret.gateway.delivered[0]?.body.entry).equal('SUDO_KIRIN_BOX');
    should(entry.gateway.delivered[0]?.body.entry).equal('SUDO_KIRIN_BOX');
    should(save.gateway.delivered[0]?.body.save).deepEqual({ entry: 'NEW_ONE', label: 'My box' });
  });

  it('should show --account in the help and hide its old spellings, which say "account" for the save too', () => {
    // Arrange
    const program = new Command().name('fy').exitOverride();
    registerInputCommands(program, new InputController(rig().ports));
    const answer = program.commands
      .find(each => each.name() === 'input')
      ?.commands.find(each => each.name() === 'answer');

    // Act
    const help = answer?.helpInformation() ?? '';
    const group = program.commands.find(each => each.name() === 'input');
    const chunks: string[] = [];
    group?.configureOutput({ writeOut: text => void chunks.push(text), writeErr: () => {} });
    group?.outputHelp();
    const after = chunks.join('');

    // Assert
    should(help).containEql('--account <name>');
    should(help).not.containEql('--secret');
    should(help).not.containEql('--entry');
    should(help).containEql('keep the value you type as this account');
    should(help).containEql('the label a new account gets with --save-as');
    should(after).containEql('answer <!A7> --account NAME');
    should(after).not.containEql('--secret');
  });

  it('should still refuse a value as a flag or argument', async () => {
    // Arrange
    const withFlag = run(['input', 'answer', '!A7', '-s', SESSION, '--password', VALUE]);

    // Act
    const failure = await withFlag.parsed.catch((error: unknown) => error);

    // Assert
    should(failure).be.an.Error();
    should(withFlag.gateway.delivered).have.length(0);
  });
});
