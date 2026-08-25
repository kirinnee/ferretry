import { describe, it } from 'bun:test';
import should from 'should';
import {
  type HarnessDocumentRead,
  type HarnessHomeLayout,
  readHarnessDiscovery,
} from '../../../src/lib/fleet/harness-discovery.ts';

/**
 * What the account form is allowed to believe about this host.
 *
 * Every case here is a sentence a person reads and acts on, so the assertions are about the WORDS as
 * much as the shape: "no model detected" and "your settings file will not parse" send somebody to two
 * different places, and a report that collapsed them would be accurate and useless.
 */

const CLAUDE: HarnessHomeLayout = {
  kind: 'claude',
  settingsPath: '/home/pilot/.claude/settings.json',
  settingsFormat: 'json',
  instructionsPath: '/home/pilot/.claude/CLAUDE.md',
  instructionsName: 'CLAUDE.md',
};

const CODEX: HarnessHomeLayout = {
  kind: 'codex',
  settingsPath: '/home/pilot/.codex/config.toml',
  settingsFormat: 'toml',
  instructionsPath: '/home/pilot/.codex/AGENTS.md',
  instructionsName: 'AGENTS.md',
};

const MAX_BYTES = 64 * 1024;

/** A reader over a fixed path→answer table. Anything unnamed is absent, which is the honest default. */
const documents = (
  answers: Readonly<Record<string, HarnessDocumentRead>>,
): { read(path: string, maxBytes: number): Promise<HarnessDocumentRead> } => ({
  read: async (path: string) => answers[path] ?? { kind: 'absent' },
});

const text = (body: string): HarnessDocumentRead => ({
  kind: 'text',
  text: body,
  bytes: Buffer.byteLength(body, 'utf8'),
});

const onPath =
  (...names: readonly string[]) =>
  (name: string): string | undefined =>
    names.includes(name) ? `/usr/local/bin/${name}` : undefined;

const discover = async (options: {
  readonly layouts?: readonly HarnessHomeLayout[];
  readonly resolve?: (name: string) => string | undefined;
  readonly files?: Readonly<Record<string, HarnessDocumentRead>>;
}) =>
  await readHarnessDiscovery({
    layouts: options.layouts ?? [CLAUDE, CODEX],
    executables: { resolve: options.resolve ?? (() => undefined) },
    documents: documents(options.files ?? {}),
    maxDocumentBytes: MAX_BYTES,
  });

describe('harness discovery', () => {
  it('should report the resolved command path for a harness that is on PATH, and nothing for one that is not', async () => {
    // Arrange — the asymmetric host, which is the common one: Claude installed, Codex not.
    const resolve = onPath('claude');

    // Act
    const report = await discover({ resolve });

    // Assert — the PATH lookup's own answer, not a boolean derived from it. Which `claude` was found is
    // the fact a person acts on when a shim or a stale copy is shadowing the one they installed.
    should(report.harnesses.map(harness => [harness.kind, harness.command])).deepEqual([
      ['claude', '/usr/local/bin/claude'],
      ['codex', undefined],
    ]);
    should(report.noneInstalled).be.false();
  });

  it('should say plainly when NO harness command resolves, rather than reporting an empty list', async () => {
    // Arrange — a host with neither installed. Every kind is still reported: "is Codex set up?" has to
    // have an answer, and an absent entry is not one.
    // Act
    const report = await discover({});

    // Assert
    should(report.noneInstalled).be.true();
    should(report.harnesses).have.length(2);
    should(report.harnesses.every(harness => harness.command === undefined)).be.true();
  });

  it('should read the default model out of each harness own settings document, in each format', async () => {
    // Arrange — the two real formats: Claude Code reads JSON, Codex reads TOML. One key name, two
    // parsers, and the parser is the shared one the provisioner already writes settings with.
    const files = {
      [CLAUDE.settingsPath]: text('{"model": "claude-opus-4-5", "theme": "dark"}'),
      [CODEX.settingsPath]: text('model = "gpt-5.6-terra"\n'),
    };

    // Act
    const report = await discover({ files, resolve: onPath('claude', 'codex') });

    // Assert
    should(report.harnesses[0]?.models).deepEqual({
      origin: 'detected',
      ids: ['claude-opus-4-5'],
      defaultModel: 'claude-opus-4-5',
      source: CLAUDE.settingsPath,
    });
    should(report.harnesses[1]?.models.defaultModel).equal('gpt-5.6-terra');
    should(report.harnesses[1]?.models.origin).equal('detected');
  });

  it('should offer EVERY model the settings document names, with the harness own choice first', async () => {
    // Arrange — a real Claude settings file with a small-fast model and a per-family default, and a real
    // Codex config with two named profiles. Both are models somebody on this host has already declared,
    // and before this the form offered one card and made them type the rest in as unverified.
    const files = {
      [CLAUDE.settingsPath]: text(
        JSON.stringify({
          model: 'claude-opus-4-5',
          env: {
            ANTHROPIC_SMALL_FAST_MODEL: 'claude-haiku-4-5',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5',
          },
        }),
      ),
      [CODEX.settingsPath]: text(
        'model = "gpt-5.6-terra"\n\n[profiles.fast]\nmodel = "gpt-5.6-sol"\n\n[profiles.other]\nmodel = "gpt-5.5"\n',
      ),
    };

    // Act
    const report = await discover({ files, resolve: onPath('claude', 'codex') });

    // Assert — the harness's own `model` leads, because the default has to be one of the ids and its own
    // choice is the honest one; the rest follow in the order the file names them.
    should(report.harnesses[0]?.models).deepEqual({
      origin: 'detected',
      ids: ['claude-opus-4-5', 'claude-haiku-4-5', 'claude-sonnet-4-5'],
      defaultModel: 'claude-opus-4-5',
      source: CLAUDE.settingsPath,
    });
    should(report.harnesses[1]?.models.ids).deepEqual(['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.5']);
    should(report.harnesses[1]?.models.defaultModel).equal('gpt-5.6-terra');
  });

  it('should offer a model named ONLY in an env block or a profile, as a detection rather than a fallback', async () => {
    // Arrange — a settings file with no top-level `model` at all. It still NAMES models, so answering
    // "nothing detected" here would offer the starter model beside a file that says otherwise.
    const files = {
      [CLAUDE.settingsPath]: text('{"env": {"ANTHROPIC_MODEL": "claude-opus-4-5"}}'),
      [CODEX.settingsPath]: text('[profiles.work]\nmodel = "gpt-5.6-sol"\n'),
    };

    // Act
    const report = await discover({ files });

    // Assert
    should(report.harnesses[0]?.models.origin).equal('detected');
    should(report.harnesses[0]?.models.defaultModel).equal('claude-opus-4-5');
    should(report.harnesses[1]?.models.ids).deepEqual(['gpt-5.6-sol']);
    should(report.harnesses[1]?.models.origin).equal('detected');
  });

  it('should offer a model named twice exactly once, and never offer an env value whose name is not a model', async () => {
    // Arrange — the rule is a NAME rule, so it has to be shown refusing. `ANTHROPIC_BASE_URL` and
    // `MODEL_TIMEOUT_MS` are values somebody wrote in this file that are not models, and offering either
    // as a card would be this report inventing a model identifier.
    const files = {
      [CLAUDE.settingsPath]: text(
        JSON.stringify({
          model: 'claude-opus-4-5',
          env: {
            ANTHROPIC_MODEL: 'claude-opus-4-5',
            ANTHROPIC_BASE_URL: 'https://example.invalid',
            MODEL_TIMEOUT_MS: '600000',
            ANTHROPIC_SMALL_FAST_MODEL: '   ',
          },
        }),
      ),
    };

    // Act
    const report = await discover({ files });

    // Assert — one card, not four: the repeat collapses, the URL and the timeout are not named MODEL, and
    // a declared value that names nothing is not a model either.
    should(report.harnesses[0]?.models.ids).deepEqual(['claude-opus-4-5']);
  });

  it('should offer the product own starter model as a labelled fallback, naming why nothing was detected', async () => {
    // Arrange — nothing in either home. A model box that cannot be filled blocks the form outright, so
    // something has to be offered; what must never happen is offering it as though the host said it.
    // Act
    const report = await discover({ resolve: onPath('claude') });

    // Assert — the ORIGIN carries the claim and the SOURCE carries the reason, so a surface cannot
    // render "detected" for a value the host never mentioned.
    should(report.harnesses[0]?.models.origin).equal('fallback');
    should(report.harnesses[0]?.models.source).match(/starter model for claude/u);
    should(report.harnesses[0]?.models.source).containEql(CLAUDE.settingsPath);
    // The identifier is the fleet package's own, so a form can never offer a model no scaffold writes.
    should(report.harnesses[0]?.models.ids).deepEqual(['claude-opus-5']);
    should(report.harnesses[1]?.models.ids).deepEqual(['gpt-5.6']);
  });

  it('should fall back with the PARSE FAILURE as its reason when a settings document will not parse', async () => {
    // Arrange — a broken settings file is not an unconfigured harness. The harness itself is failing to
    // read this file too, and "no model detected" would send somebody looking in the wrong place.
    const files = { [CLAUDE.settingsPath]: text('{"model": ') };

    // Act
    const report = await discover({ files });

    // Assert
    should(report.harnesses[0]?.models.origin).equal('fallback');
    should(report.harnesses[0]?.models.source).match(/is not valid json/u);
  });

  it('should fall back when the settings document parses and names no usable model', async () => {
    // Arrange — present, valid, and silent about the model; plus the whitespace-only case, which is a
    // declared value that could not name anything.
    const files = {
      [CLAUDE.settingsPath]: text('{"theme": "dark"}'),
      [CODEX.settingsPath]: text('model = "   "\n'),
    };

    // Act
    const report = await discover({ files });

    // Assert — the sentence names EVERY place that was looked in, because the rule is otherwise invisible:
    // a person who keeps their model in an env block needs to know that was searched too.
    should(report.harnesses[0]?.models.source).match(/names no model in "model", an env name ending in MODEL/u);
    should(report.harnesses[0]?.models.source).match(/or a profile's own "model"/u);
    should(report.harnesses[1]?.models.source).match(/names no model in "model"/u);
  });

  it('should fall back when the settings document could not be read or was too large to read', async () => {
    // Arrange — two failures that are neither absence nor a parse error, and both worth their own words.
    const files = {
      [CLAUDE.settingsPath]: { kind: 'unreadable', reason: 'EACCES: permission denied' } as HarnessDocumentRead,
      [CODEX.settingsPath]: { kind: 'too-large', bytes: 900_000 } as HarnessDocumentRead,
    };

    // Act
    const report = await discover({ files });

    // Assert
    should(report.harnesses[0]?.models.source).match(/could not be read \(EACCES/u);
    should(report.harnesses[1]?.models.source).match(/is 900000 bytes and was not read/u);
  });

  it('should carry the instructions document text and the absolute path it came from', async () => {
    // Arrange — the whole point of the import: the text travels so the form can OFFER it, and the path
    // travels so the offer is checkable rather than a mystery block of prose.
    const body = '# House rules\n\nBe exact.\n';
    const files = { [CLAUDE.instructionsPath]: text(body) };

    // Act
    const report = await discover({ files, resolve: onPath('claude') });

    // Assert
    should(report.harnesses[0]?.instructions).deepEqual({
      found: true,
      source: CLAUDE.instructionsPath,
      text: body,
      bytes: Buffer.byteLength(body, 'utf8'),
    });
  });

  it('should name where it looked when there is no instructions document there', async () => {
    // Arrange — "not found" is only useful with the path attached: otherwise nobody can tell whether the
    // daemon looked in the place they keep it.
    // Act
    const report = await discover({});

    // Assert
    should(report.harnesses[1]?.instructions).deepEqual({
      found: false,
      source: CODEX.instructionsPath,
      reason: 'this host has no AGENTS.md there',
    });
  });

  it('should refuse to offer an instructions document larger than one fleet asset may carry', async () => {
    // Arrange — the failure mode this avoids is the quiet one: importing the first 64 KiB of somebody's
    // instructions and writing it back over the whole document. Reported with its size and the ceiling.
    const files = { [CLAUDE.instructionsPath]: { kind: 'too-large', bytes: 120_000 } as HarnessDocumentRead };

    // Act
    const report = await discover({ files });
    const instructions = report.harnesses[0]?.instructions;

    // Assert
    should(instructions?.found).be.false();
    should(instructions?.found === false && instructions.reason).match(/120000 bytes, over the 65536-byte ceiling/u);
  });

  it('should carry the read failure verbatim when the instructions document could not be read', async () => {
    // Arrange
    const files = {
      [CLAUDE.instructionsPath]: {
        kind: 'unreadable',
        reason: 'that path is not a regular file',
      } as HarnessDocumentRead,
    };

    // Act
    const report = await discover({ files });
    const instructions = report.harnesses[0]?.instructions;

    // Assert — the reader's own sentence, not a summary of it.
    should(instructions?.found === false && instructions.reason).equal('that path is not a regular file');
  });

  it('should state what each harness absence breaks whether or not it is missing, and disclaim what it proves', async () => {
    // Arrange — the impact is stated for a PRESENT harness too, because the report is read as a
    // reference for "what does this program do for me", not only as an error list.
    // Act
    const report = await discover({ resolve: onPath('claude') });

    // Assert
    should(report.harnesses[0]?.absenceImpact).match(/no Claude session can start/u);
    should(report.harnesses[1]?.absenceImpact).match(/no Codex session can start/u);
    // The limit travels with the evidence so no surface has to remember to say it — including the one
    // this report is honest about NOT publishing: several models share one `source`, and which key named
    // which is a wire field and a surface change rather than a read.
    should(report.limitation).match(/does not prove a harness is signed in/u);
    should(report.limitation).match(/which key named which model is not said/u);
  });
});
