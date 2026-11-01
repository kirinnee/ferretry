import { describe, it } from 'bun:test';
import should from 'should';
import { InputController } from '../../../src/lib/input/controller';
import { renderInputList, showUntrusted } from '../../../src/lib/input/render';
import { FakeInputGateway, request, rig, SESSION } from './fixtures';

const RAW_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const RISK = { level: 'red', reason: 'Not secret: the ferret can see this value.' } as const;
const NOW = Date.parse('2026-10-30T09:02:00.000Z');

async function shown(hostile: Parameters<typeof request>[0]): Promise<string[]> {
  const { ports, out } = rig({}, new FakeInputGateway([request({ risk: RISK, ...hostile })]));
  await new InputController(ports).answer('A7', { session: SESSION });
  return out.diagnostics;
}

describe('untrusted text on the owner’s screen', () => {
  it('should spell out a prompt that tries to conceal the risk line, and keep the risk line intact', async () => {
    const lines = await shown({ prompt: 'Enter password\u001b[8m' });

    for (const line of lines) should(line).not.match(RAW_CONTROL);
    should(lines).containEql('the agent says: Enter password\\x1b[8m');
    should(lines).containEql('risk red: Not secret: the ferret can see this value.');
  });

  it('should spell out bidi overrides and zero-width characters', async () => {
    const lines = await shown({ prompt: 'pay\u202eevil\u200b\u2066x\u2069' });

    for (const line of lines) should(line).not.match(RAW_CONTROL);
    should(lines).containEql('the agent says: pay\\u{202e}evil\\u{200b}\\u{2066}x\\u{2069}');
  });

  it('should spell out the daemon-observed program and prompt line, and never print argv', async () => {
    const base = request();
    const lines = await shown({
      observed: {
        ...base.observed!,
        foreground: { pid: 1, pgid: 1, comm: 'su\u001bdo', argv: 'sudo \u001b[8m' },
        program: undefined,
        recognisedConsumer: false,
        promptLine: 'password:\u009b8m\u007f\nfake',
      } as never,
    });

    for (const line of lines) should(line).not.match(RAW_CONTROL);
    should(lines.join('\n')).not.containEql('argv');
    should(lines).containEql(
      'reading the terminal now: su\\x1bdo (UNVERIFIED: Ferretry could not prove which program this is)',
    );
    should(lines).containEql('its prompt line: password:\\x9b8m\\x7f\\x0afake');
  });

  it('should name a paste into the secret store by the secret, and say when it replaces one', async () => {
    const into = (exists: boolean) =>
      shown({
        target: { kind: 'secret', key: 'VERCEL_TOKEN' },
        observed: { kind: 'secret', name: 'VERCEL_TOKEN', exists },
        source: { kind: 'sealed', name: 'vercel', from: { kind: 'command', program: 'gh' } },
      } as never);

    const fresh = await into(false);
    const replacing = await into(true);

    should(fresh[0]).containEql('into the secret VERCEL_TOKEN');
    should(fresh).containEql('it adds the new secret VERCEL_TOKEN');
    should(replacing).containEql('it REPLACES the value VERCEL_TOKEN holds now');
  });

  it('should spell out a restored prompt in the list', () => {
    const text = renderInputList({ requests: [request({ prompt: 'again\u001b]0;pwned\u0007‮' })] }, NOW);

    for (const line of text.split('\n')) should(line).not.match(RAW_CONTROL);
    should(text).containEql('the agent says: again\\x1b]0;pwned\\x07\\u{202e}');
    should(text.split('\n')).have.length(2);
  });

  it('should spell out a byte-order mark', () => {
    should(showUntrusted('a\ufeffb')).equal('a\\u{feff}b');
  });

  it('should leave ordinary and non-latin text alone', () => {
    should(showUntrusted('sudo パスワード — ok')).equal('sudo パスワード — ok');
  });
});
