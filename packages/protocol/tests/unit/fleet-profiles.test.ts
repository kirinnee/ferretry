/**
 * The wire shape of a profile: shapes, never values.
 *
 * The read half obeys `docs/secrets.md` STRUCTURALLY rather than by convention, and that is what these
 * cases are for. `FleetEnvValueShapeSchema` is strict on all three arms, so there is nowhere a value
 * could travel — and the `literal` arm carries no text AT ALL, which is a deliberate emptiness rather
 * than an unfinished field: most literals are harmless, some are not, and no rule deciding which stays
 * right.
 *
 * The write half is a discriminated union of the three spellings rather than a free string, and the
 * refusals below are the point of that narrowing: a caller who could send `env` as text could send
 * `${secret:work_key}` — a near miss the grammar does not match, so it would stay a literal, be
 * exported into a child verbatim, and authenticate with the eighteen characters of the reference.
 *
 * NO CREDENTIAL APPEARS HERE. Every secret is named and never valued, because there is no field for one.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import * as profiles from '../../src/lib/fleet-profiles.ts';
import { assertCoversEverySchema, assertRejects, assertRoundTrips, type SchemaCase } from './schema-cases.ts';

const cases: readonly SchemaCase[] = [
  { name: 'FleetEnvVariableSchema', schema: profiles.FleetEnvVariableSchema, value: 'ANTHROPIC_API_KEY' },
  {
    name: 'FleetEnvValueShapeSchema',
    schema: profiles.FleetEnvValueShapeSchema,
    value: { shape: 'secret', secrets: ['WORK_KEY'] },
  },
  {
    name: 'FleetProfileVariableSchema',
    schema: profiles.FleetProfileVariableSchema,
    value: { variable: 'ANTHROPIC_API_KEY', shape: { shape: 'secret', secrets: ['WORK_KEY'] }, harness: 'claude' },
  },
  {
    name: 'FleetProfileViewSchema',
    schema: profiles.FleetProfileViewSchema,
    value: {
      name: 'work',
      appliesToEveryAccount: false,
      variables: [{ variable: 'ANTHROPIC_API_KEY', shape: { shape: 'secret', secrets: ['WORK_KEY'] } }],
      accounts: ['claude-studio'],
      authenticates: ['claude'],
    },
  },
  {
    name: 'FleetProfileCatalogSchema',
    schema: profiles.FleetProfileCatalogSchema,
    value: {
      profiles: [
        { name: 'base', appliesToEveryAccount: true, variables: [], accounts: ['claude-studio'], authenticates: [] },
      ],
      credentialVariables: { claude: ['ANTHROPIC_API_KEY'], codex: ['OPENAI_API_KEY'] },
    },
  },
  {
    name: 'FleetProfileVariableDeclarationSchema',
    schema: profiles.FleetProfileVariableDeclarationSchema,
    value: { from: 'secret', variable: 'ANTHROPIC_API_KEY', secret: 'WORK_KEY' },
  },
  {
    name: 'FleetProfileDeclarationSchema',
    schema: profiles.FleetProfileDeclarationSchema,
    value: { name: 'work', variables: [{ from: 'value', variable: 'ANTHROPIC_BASE_URL', value: 'https://x.invalid' }] },
  },
];

describe('the profile wire contract', () => {
  it('should round-trip every shape a browser reads and every declaration it may send', () => {
    // Act & Assert
    assertRoundTrips(cases);
    assertCoversEverySchema(profiles, cases);
  });

  it('should have nowhere at all to put a value, which is the whole read contract', () => {
    // Arrange — a value would have to arrive as an extra field, and every arm is strict, so it is
    // REFUSED rather than stripped. Stripping would be the same wire either way and would leave the
    // property resting on whichever end happened to be doing the parsing.
    assertRejects([
      {
        name: 'a literal that carries its text',
        schema: profiles.FleetEnvValueShapeSchema,
        value: { shape: 'literal', text: 'sk-fixture' },
      },
      {
        name: 'a secret that carries its value',
        schema: profiles.FleetEnvValueShapeSchema,
        value: { shape: 'secret', secrets: ['WORK_KEY'], value: 'sk-fixture' },
      },
      {
        name: 'a variable that carries its value',
        schema: profiles.FleetProfileVariableSchema,
        value: { variable: 'ANTHROPIC_API_KEY', shape: { shape: 'literal' }, value: 'sk-fixture' },
      },
      {
        name: 'a profile view that carries an env map',
        schema: profiles.FleetProfileViewSchema,
        value: {
          name: 'work',
          appliesToEveryAccount: false,
          variables: [],
          accounts: [],
          authenticates: [],
          env: { ANTHROPIC_API_KEY: 'sk-fixture' },
        },
      },
    ]);
  });

  it('should accept a literal with no text and reject one that has any', () => {
    // Assert — the emptiness is the contract. A reader who "completed" this arm with the text would be
    // adding the one field the read half exists not to have.
    should(profiles.FleetEnvValueShapeSchema.parse({ shape: 'literal' })).deepEqual({ shape: 'literal' });
    should(profiles.FleetEnvValueShapeSchema.safeParse({ shape: 'literal', value: '' }).success).be.false();
  });

  it('should refuse a secret arm that names no secret, because it would explain nothing', () => {
    // Arrange — "from the secret store" with no name tells somebody a value comes from somewhere they
    // cannot go and look. The arm exists to name what to set.
    assertRejects([
      { name: 'no secrets', schema: profiles.FleetEnvValueShapeSchema, value: { shape: 'secret', secrets: [] } },
    ]);
  });

  it('should hold a declared secret to the store’s own name shape, not to a variable’s', () => {
    // Arrange — `${secret:work_key}` matches nothing and would stay a literal. Naming the secret in its
    // own field makes that unsayable, and the lower-case spelling can only arrive as a secret NAME.
    assertRejects([
      {
        name: 'a lower-case secret name',
        schema: profiles.FleetProfileVariableDeclarationSchema,
        value: { from: 'secret', variable: 'ANTHROPIC_API_KEY', secret: 'work_key' },
      },
      {
        name: 'a spelt-out reference where a name belongs',
        schema: profiles.FleetProfileVariableDeclarationSchema,
        value: { from: 'secret', variable: 'ANTHROPIC_API_KEY', secret: '${secret:WORK_KEY}' },
      },
    ]);
    // The environment answer takes a variable name, which is the laxer of the two shapes.
    should(
      profiles.FleetProfileVariableDeclarationSchema.parse({
        from: 'environment',
        variable: 'HTTPS_PROXY',
        source: 'outer_proxy',
      }),
    ).deepEqual({ from: 'environment', variable: 'HTTPS_PROXY', source: 'outer_proxy' });
  });

  it('should refuse a declaration that sets nothing, because it would compose nothing', () => {
    // Arrange — a name in the configuration no account could be authenticated by, offered by a surface
    // as an answer with no effect.
    assertRejects([
      { name: 'no variables', schema: profiles.FleetProfileDeclarationSchema, value: { name: 'work', variables: [] } },
      { name: 'no name', schema: profiles.FleetProfileDeclarationSchema, value: { name: '', variables: [] } },
    ]);
  });

  it('should refuse a variable name no shell would export', () => {
    assertRejects([
      { name: 'a hyphen', schema: profiles.FleetEnvVariableSchema, value: 'not-a-name' },
      { name: 'a leading digit', schema: profiles.FleetEnvVariableSchema, value: '1KEY' },
      { name: 'empty', schema: profiles.FleetEnvVariableSchema, value: '' },
    ]);
  });

  it('should not restate the reserved names the fleet refuses by name', () => {
    // Arrange — `CLAUDE_CONFIG_DIR` and its siblings are refused by the fleet's own `EnvSchema`, which
    // names the offending variable in a sentence a person reads. A second copy of that list here is the
    // one that goes stale the day a third harness arrives, so this schema accepts the shape and the
    // refusal stays where it can explain itself.
    should(profiles.FleetEnvVariableSchema.safeParse('CLAUDE_CONFIG_DIR').success).be.true();
  });

  it('should refuse a catalog missing either harness’s credential variables', () => {
    // Arrange — `credentialVariables` is the HOST's list travelling so a browser never holds a second
    // copy of which variables stand in for a login. A half-answer would leave one harness to guess.
    assertRejects([
      {
        name: 'only claude',
        schema: profiles.FleetProfileCatalogSchema,
        value: { profiles: [], credentialVariables: { claude: ['ANTHROPIC_API_KEY'] } },
      },
    ]);
    // An empty profile list IS an ordinary fleet rather than a broken one: a profile is opt-in.
    should(
      profiles.FleetProfileCatalogSchema.parse({
        profiles: [],
        credentialVariables: { claude: [], codex: [] },
      }).profiles,
    ).deepEqual([]);
  });
});
