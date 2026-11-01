import { describe, it } from 'bun:test';
import { CONFIG_COMPONENT_KINDS, classifyConfigPath } from '@ferretry/protocol';
import should from 'should';
import { checkConfigFile } from '../../../src/lib/config-files/check.ts';
import { SET_UP_FERRETRY_SKILL_NAME, setUpFerretrySkill } from '../../../src/lib/config-files/skill.ts';

/** The `# path` + body of every fenced yaml example in the skill. */
const examples = (text: string): { path: string; body: string }[] =>
  [...text.matchAll(/```yaml\n# (\S+)\n([\s\S]*?)```/gu)].map(match => ({
    path: match[1] as string,
    body: match[2] as string,
  }));

describe('setUpFerretrySkill', () => {
  it('should be a SKILL.md: frontmatter naming the skill, then a body', () => {
    // Act
    const actual = setUpFerretrySkill('fy');

    // Assert
    should(actual.startsWith(`---\nname: ${SET_UP_FERRETRY_SKILL_NAME}\ndescription: `)).be.true();
    should(actual.split('\n---\n')).have.length(2);
    should(actual.endsWith('\n')).be.true();
  });

  it('should name the skill the way a skills directory spells it', () => {
    should(SET_UP_FERRETRY_SKILL_NAME).equal('set-up-ferretry');
  });

  it.each(['fy', 'ferretry-bin'])('should name the binary %s in every command, and no other binary', bin => {
    // Act
    const actual = setUpFerretrySkill(bin);

    // Assert
    const commands = [...actual.matchAll(/`(\S+) (config|secret) [^`]*`/gu)].map(match => match[1]);
    should(commands.length).be.above(4);
    for (const command of commands) should(command).equal(bin);
    should(actual).not.containEql('${bin}');
  });

  it('should differ between two binaries only where the binary is named', () => {
    // Act
    const one = setUpFerretrySkill('aaa');
    const other = setUpFerretrySkill('bbb');

    // Assert
    should(one.replaceAll('aaa', 'bbb')).equal(other);
  });

  it('should tell an agent that machine.yaml holds the browser ports, and what each word means', () => {
    // Act
    const actual = setUpFerretrySkill('fy');

    // Assert
    should(actual).containEql('`browserPorts`');
    should(actual).containEql('`browserFirewallFailure`');
    should(actual).containEql('`per-user`');
    should(actual).containEql('loopback firewall');
  });

  it('should state the two rules that matter: no secret value in a file, and check after every edit', () => {
    // Act
    const actual = setUpFerretrySkill('fy');

    // Assert
    should(actual).containEql('Never write a secret value into a file');
    should(actual).containEql('`fy secret set NAME`');
    should(actual).containEql('${secret:NAME}');
    should(actual).containEql('`fy config check` after every edit');
  });

  it('should say a loosening edit waits for the owner, and how the owner confirms it', () => {
    // Act
    const actual = setUpFerretrySkill('fy');

    // Assert
    should(actual).containEql('waits for the owner');
    should(actual).containEql('`fy config confirm`');
    should(actual).containEql('passkey');
  });

  it('should list every component kind the files can hold', () => {
    // Act
    const actual = setUpFerretrySkill('fy');

    // Assert
    for (const kind of CONFIG_COMPONENT_KINDS) should(actual).containEql(`\`${kind}\``);
  });

  it('should give every file location it names a place Ferretry reads', () => {
    // Arrange
    const actual = setUpFerretrySkill('fy');
    const named = [...actual.matchAll(/^\| `((?:[a-z]+\/)*[a-z-]+\.yaml|[a-z<>/]+\.yaml)` \|/gmu)].map(
      match => match[1] as string,
    );

    // Act
    const unread = named.filter(
      path =>
        classifyConfigPath(path.replace('<id>', 'a').replace('<kind>', 'mcp').replace('<name>', 'a')) === undefined,
    );

    // Assert
    should(named.length).equal(11);
    should(unread).deepEqual([]);
  });

  it('should give examples that Ferretry itself accepts', () => {
    // Act
    const actual = examples(setUpFerretrySkill('fy'));

    // Assert
    should(actual.length).equal(3);
    for (const { path, body } of actual) {
      const checked = checkConfigFile(path, body);
      should(checked.issues).deepEqual([]);
      should(checked.ok).be.true();
    }
  });

  it('should show a secret only as a reference in its examples', () => {
    // Act
    const actual = setUpFerretrySkill('fy');

    // Assert
    should(actual).containEql('${secret:GITHUB_TOKEN}');
    should(actual).containEql('${secret:GLM_API_KEY}');
  });
});
