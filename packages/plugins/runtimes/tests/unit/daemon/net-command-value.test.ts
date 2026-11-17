/**
 * CFG-LEAK (ii) fix 3 (I): ONE rule for an MCP server's `command` in every view that shows it (the detail, the Resolved
 * line, the warning): withheld when the write rule refuses it (as a string or as its words), or when the word cutter,
 * run on the command as ONE string, cuts a part that is a VALUE; a part that is a pointer (`$X`, `${X}`,
 * `${secret:X}`) is not one, so `env API_KEY=$API_KEY srv` is shown as written. A header pair across the blanks of a
 * command (`Authorization: Bearer v`, one word to the write rule's boundary) was shown in full by the Resolved line
 * once it split the command at its blanks. Fake values only.
 *
 * How it grows at 256 KiB is tests/perf/daemon/net-command-value.test.ts.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import { commandWithheld } from '../../../daemon/lib/service/command-line.ts';
import { resolveProfile } from '../../../daemon/lib/account/layering.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';
import { type CatalogFacts, componentCatalog } from '../../../daemon/lib/service/catalog.ts';
import { resolvedEntries } from '../../../daemon/lib/service/resolved-view.ts';

const V = 'Zk3pQ9vXw2LmN7rT';
const FACTS: CatalogFacts = {
  format: 'present',
  machineName: 'studio',
  tools: { claude: '/usr/bin/claude', codex: undefined },
  runningSessions: 0,
  userHome: '/home/person',
  acceptsAutoPermissionMode: true,
};
const WITHHELD = 'withheld';

/** What the Resolved line and the detail show of a server started by `command` and `args`. */
function views(command: string, args: readonly string[] = []) {
  const parsed = parseAccountModel({
    version: 1,
    components: { mcp: { srv: { command, args: [...args] } } },
    profiles: { p: { layers: ['mcp/srv'] } },
  });
  const result = resolveProfile({ model: parsed, profile: 'p', harness: 'claude', settingsBodies: {} });
  if (!result.ok) throw new Error('expected a resolution');
  const resolved = resolvedEntries(result.resolved).find(entry => entry.field === 'mcp')?.value ?? '';
  const detail = componentCatalog(parsed, FACTS)
    .kinds.flatMap(group => group.components)
    .find(component => component.reference === 'mcp/srv')?.detail;
  return { resolved, detail: JSON.stringify(detail), held: detail?.kind === 'mcp' && detail.commandWithheld === true };
}

/** The four header-pair shapes the regression showed, each in its layouts: quoted, unquoted, two blanks, a tab. */
const PAIRS: Readonly<Record<string, readonly string[]>> = {
  'curl with a quoted Authorization header': [
    `curl -H "Authorization: Bearer ${V}" https://h`,
    `curl -H 'Authorization: Bearer ${V}' https://h`,
    `curl  -H  "Authorization:  Bearer  ${V}"  https://h`,
    `curl\t-H\t"Authorization:\tBearer\t${V}"\thttps://h`,
  ],
  'npx with --header Authorization': [
    `npx srv --header Authorization: Bearer ${V}`,
    `npx srv --header "Authorization: Bearer ${V}"`,
    `npx  srv  --header  Authorization:  Bearer  ${V}`,
    `npx\tsrv\t--header\tAuthorization:\tBearer\t${V}`,
  ],
  'npx with -H X-Api-Key': [
    `npx srv -H X-Api-Key: ${V}`,
    `npx srv -H "X-Api-Key: ${V}"`,
    `npx  srv  -H  X-Api-Key:  ${V}`,
    `npx\tsrv\t-H\tX-Api-Key:\t${V}`,
  ],
  'srv with -H Cookie': [
    `srv -H Cookie: session=${V}`,
    `srv -H "Cookie: session=${V}"`,
    `srv  -H  Cookie:  session=${V}`,
    `srv\t-H\tCookie:\tsession=${V}`,
  ],
};

describe('(I) a command is withheld in every view when the cutter cuts a value in it', () => {
  for (const [name, commands] of Object.entries(PAIRS)) {
    for (const [at, command] of commands.entries()) {
      it(`should show no value of ${name} in the Resolved line or the detail (${String(at + 1)})`, () => {
        // Act
        const seen = views(command);

        // Assert
        should(commandWithheld(command)).be.true();
        should(seen.resolved).not.containEql(V);
        should(seen.detail).not.containEql(V);
        should(seen.held).be.true();
      });
    }
  }

  it('should withhold the whole Resolved line, with the plain sentence, never a part of it', () => {
    // Act
    const seen = views(`curl -H "Authorization: Bearer ${V}" https://h`);

    // Assert
    should(seen.resolved).not.containEql('curl');
    should(seen.resolved).not.containEql('‹hidden›');
  });

  for (const command of [
    'env API_KEY=$API_KEY srv',
    'env API_KEY=${API_KEY} srv',
    'env API_KEY=${secret:API} srv',
    'srv --token ${secret:X}',
    'env API_KEY="$API_KEY" srv',
  ]) {
    it(`should show the pointer control as written in both views: ${command}`, () => {
      // Act
      const seen = views(command);

      // Assert
      should(commandWithheld(command)).be.false();
      should(seen.resolved).equal(command.split(/\s+/u).join(' '));
      should(seen.held).be.false();
      should(seen.detail).containEql(JSON.stringify(command).slice(1, -1));
    });
  }

  for (const command of [`env API_KEY=${V} srv`, `srv --token ${V}`, `env API_KEY=$API_KEY,${V} srv`]) {
    it(`should still withhold a command that holds a value: ${command.slice(0, 24)}`, () => {
      // Act
      const seen = views(command);

      // Assert
      should(commandWithheld(command)).be.true();
      should(seen.resolved).not.containEql(V);
      should(seen.held).be.true();
    });
  }

  it('should still catch a flag at the end of the command and its value as the first argument', () => {
    // Act
    const seen = views('srv --token', [V]);

    // Assert
    should(seen.resolved).not.containEql(V);
    should(JSON.stringify(seen.detail)).not.containEql(V);
  });

  for (const command of [
    'srv --token-file ~/.config/tool/token',
    'srv --key /home/u/.ssh/id_ed25519',
    'srv --key ./keys/server.pem',
    'srv --token-file ../tool/token',
    'srv --token-file /etc/tool/token',
    'env API_KEY="$API_KEY" npx -y @scope/pkg',
    'env API_KEY="${secret:X}" npx -y @scope/pkg',
  ]) {
    it(`should show a path flag or a quoted pointer as written, W accepts it: ${command}`, () => {
      // Act
      const seen = views(command);

      // Assert
      should(commandWithheld(command)).be.false();
      should(seen.resolved).equal(command);
      should(seen.held).be.false();
    });
  }

  for (const command of [
    `srv --key https://person:${V}@h.example/key`,
    `srv --key ./keys?token=${V}`,
    `srv --token-file /a/b --token ${V}`,
    `env API_KEY="${V}" npx -y @scope/pkg`,
    `env API_KEY="$API_KEY" ${V}`,
  ]) {
    it(`should still withhold a path flag that is a URL with a value in it, or any value beside it: ${command.slice(0, 30)}`, () => {
      // Act
      const seen = views(command);

      // Assert
      should(commandWithheld(command)).be.true();
      should(seen.resolved).not.containEql(V);
      should(seen.detail).not.containEql(V);
    });
  }

  // A place is a real path right after a flag word and nothing else: each shape below was shown by the first cut of the
  // place rule and is a value, so each is withheld in every view, as the arguments form withholds it.
  const B64 = '/9j4AAQSkZJRgABAQEASABIAAD';
  const W20 = 'Zk3pQ9vXw2LmN7rTq8Yb';
  const NOT_PLACES: readonly (readonly [string, string])[] = [
    ['a bare /word after --password', `srv --password /hunter2hunter2`],
    ['a ~word after --password', `srv --password ~hunter2hunter2`],
    ['a base64 value that starts with a slash after --password', `srv --password ${B64}`],
    ['a base64 value that starts with a slash after --api-key', `srv --api-key ${B64}`],
    ['a base64 value that starts with a slash glued with =', `srv --token=${B64}`],
    ['a pointer glued into a path', `srv --token /x\${secret:K}${W20}`],
    ['a value after KEY= that starts with a slash', `srv API_KEY=/${W20}`],
    ['a value after KEY= that starts with ./', `srv API_KEY=./${W20}`],
    ['a value after a bare KEY= that starts with a slash', `srv KEY=/${W20}`],
    ['a value after a Header: glued to its colon', `srv -H Authorization:/${W20}`],
    ['a value after a Header: that is its own word', `srv --header Authorization: /${W20}`],
    ['an http URL', `srv --token http://${W20}`],
    ['a URL of an unknown scheme', `srv --token x://${W20}`],
    ['a URL whose scheme has a +', `srv --token a+b://${W20}`],
    ['a URL with the value in its path', `srv --token https://h/${W20}`],
    ['a fragment in a path', `srv --token ./x#${W20}`],
    ['a ~word', `srv --token ~${W20}`],
    ['a .word', `srv --token .${W20}`],
  ];
  for (const [name, command] of NOT_PLACES) {
    it(`should withhold ${name}, in the Resolved line and the detail`, () => {
      // Act
      const seen = views(command);

      // Assert
      should(commandWithheld(command)).be.true();
      for (const value of [W20, B64, 'hunter2']) {
        should(seen.resolved).not.containEql(value);
        should(seen.detail).not.containEql(value);
      }
      should(seen.held).be.true();
    });
  }

  // Round 2: under a credential-named flag that is not a pointer flag (no -file / -path / -dir suffix) the next word is
  // NEVER a place, even when it looks like a path: it is withheld. A pointer flag keeps round 1's rule.
  it('should withhold a path-looking word after --token, as a value: ./V', () => {
    // Arrange
    const command = `srv --token ./${W20}`;

    // Act
    const seen = views(command);

    // Assert
    should(commandWithheld(command)).be.true();
    should(seen.resolved).not.containEql(W20);
    should(seen.detail).not.containEql(W20);
    should(seen.held).be.true();
  });

  it('should withhold a path-looking word after --token, as a value: /tmp/V', () => {
    // Arrange
    const command = `srv --token /tmp/${W20}`;

    // Act
    const seen = views(command);

    // Assert
    should(commandWithheld(command)).be.true();
    should(seen.resolved).not.containEql(W20);
    should(seen.detail).not.containEql(W20);
    should(seen.held).be.true();
  });

  it('should withhold a path-looking word after --password: /a/b', () => {
    // Act
    const command = 'srv --password /a/b';

    // Assert
    should(commandWithheld(command)).be.true();
    should(views(command).held).be.true();
  });

  it('should still show a path after a pointer flag: --token-file ./V', () => {
    // Arrange
    const command = `srv --token-file ./${W20}`;

    // Act
    const seen = views(command);

    // Assert
    should(commandWithheld(command)).be.false();
    should(seen.resolved).equal(command);
    should(seen.held).be.false();
  });

  it('should still show a path after --key: /home/u/.ssh/id_ed25519', () => {
    // Arrange
    const command = 'srv --key /home/u/.ssh/id_ed25519';

    // Act
    const seen = views(command);

    // Assert
    should(commandWithheld(command)).be.false();
    should(seen.resolved).equal(command);
    should(seen.held).be.false();
  });

  // A `--settings` document that does not parse, in each shape the reviewer's probe wrote it, shows no value.
  const BROKEN_SETTINGS: readonly (readonly [string, string])[] = [
    ['a bare value', `{"API_KEY": ${W20}}`],
    ['a missing colon', `{"API_KEY" "${W20}"}`],
    ['a key after stray closing marks', `{"x":}}}"API_KEY":"${W20}"}`],
    ['a key after unclosed lists', `{"x":[[[[ "API_KEY":"${W20}"}`],
    ['single quotes', `{'API_KEY':'${W20}'}`],
    ['escaped quotes', `{\\"API_KEY\\":\\"${W20}\\"}`],
    ['escaped quotes inside a pair of quotes', `"{\\"API_KEY\\":\\"${W20}\\"}"`],
  ];
  for (const [name, document] of BROKEN_SETTINGS) {
    it(`should withhold a --settings document that does not parse: ${name}`, () => {
      // Act: the document is an argument, after the flag that names it
      const seen = views('srv', ['--settings', document]);

      // Assert
      should(seen.resolved).not.containEql(W20);
      should(seen.detail).not.containEql(W20);
    });
  }

  it('should show a real path only as the word right after a flag word, never after KEY= or a Header:', () => {
    // Act
    const afterFlag = commandWithheld('srv --token-file ~/.config/tool/token');
    const afterKey = commandWithheld('srv API_KEY=~/.config/tool/token');
    const afterHeader = commandWithheld('srv --header Authorization: ~/.config/tool/token');

    // Assert
    should(afterFlag).be.false();
    should(afterKey).be.true();
    should(afterHeader).be.true();
  });

  it('should show a plain command and its arguments as before', () => {
    // Act
    const seen = views('npx', ['-y', '@scope/pkg']);

    // Assert
    should(seen.resolved).equal('npx -y @scope/pkg');
    should(WITHHELD).equal('withheld');
  });
});

describe('a shell default is a value, never a pointer', () => {
  const withheld = (command: string): boolean => commandWithheld(command);

  it.each([
    ['a short literal', 'env API_KEY=${X:-hunter2} srv'],
    ['an empty default', 'env API_KEY=${X:-} srv'],
    ['a message', 'env API_KEY=${X:?hunter2} srv'],
    ['a long literal', `env API_KEY=\${X:-${V}} srv`],
    ['a default under a long plain name', `env API_KEY=\${${'A'.repeat(60)}:-${V}} srv`],
  ])('should withhold a command whose cut is %s, so the default is never shown as written', (_label, command) => {
    should(withheld(command)).be.true();
  });

  it('should still show a pointer as written', () => {
    should(withheld('env API_KEY=${X} srv')).be.false();
    should(withheld('env API_KEY=$X srv')).be.false();
    should(withheld('env API_KEY="${secret:X}" srv')).be.false();
  });
});
