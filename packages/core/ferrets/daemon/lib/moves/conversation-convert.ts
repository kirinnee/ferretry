import { join } from 'node:path';
import type { Harness, TranscriptProvenance } from '@ferretry/protocol';
import type { HandoffDocuments } from '../imports/conversation-text.ts';
import { claudeTranscriptFile } from '../session/transcript/claude-path.ts';
import { codexCorrelationArguments } from '../session/transcript/codex-rollout.ts';
import {
  type ConversionResult,
  type ConversionSummary,
  type ConvertedFile,
  convertConversation,
} from '../transcript/convert/convert.ts';
import type { RolloutFormatVerdict } from '../transcript/convert/rollout-format.ts';
import { harnessVersionRefusal } from '../transcript/convert/versions.ts';
import { codexRolloutRelativePath } from '../transcript/convert/write-codex.ts';

/**
 * Moving a session onto the OTHER harness by converting its conversation: the plan, and the ports it
 * is carried out through.
 *
 * A same-harness migration carries the transcript as it is ({@link planConversationCarry}). Across
 * harnesses there is nothing to carry — Codex cannot read a Claude transcript — so the conversation is
 * WRITTEN AGAIN in the target's format under a fresh id the target owns, and the session is rebound to
 * that. The source transcript is left exactly where it was: it is the record of what happened, and the
 * converted one is a derivative that says so in its first message.
 *
 * NOTHING IS SWITCHED UNTIL THE TARGET CLI HAS ACCEPTED IT. The conversion is pure and could be wrong
 * about a format nobody documents, so before the session is touched the target CLI resumes a
 * throwaway copy in a throwaway home against a loopback model ({@link ConversionCheckPort}), and the
 * copy counts only if the history arrives at the model in order. Any doubt is a refusal in plain words
 * and the session stays where it was.
 *
 * Pure: the caller reads the transcript, writes the files and runs the check.
 */

/** The folder inside the session directory where a conversion's attachments are saved. */
export const CONVERSION_ATTACHMENTS = 'conversions';

/** What the plan knows before it decides. */
export interface ConversationConvertRequest {
  readonly sourceHarness: Harness;
  readonly targetHarness: Harness;
  /** The transcript the session is bound to now. */
  readonly source: TranscriptProvenance | undefined;
  /** The source transcript's text, or `undefined` when the file is not there. */
  readonly sourceText: string | undefined;
  readonly documents: HandoffDocuments;
  /** The harness home the target login's wrapper exports. */
  readonly targetHome: string | undefined;
  /** The target CLI's `--version` banner, when it could be read. */
  readonly targetVersion: string | undefined;
  /**
   * Codex: the rollout format the installed binary writes, probed when its version is outside the
   * tested table. Without it such a version is refused.
   */
  readonly targetFormat?: RolloutFormatVerdict;
  /** Codex: the model provider the target login's configuration selects, when it names one. */
  readonly targetModelProvider?: string;
  readonly targetAgent: string;
  /** The model the target runtime will run. */
  readonly targetModel?: string;
  readonly targetWindow: number;
  readonly cwd: string;
  /** The session's own directory: the Codex correlation token, and where attachments are saved. */
  readonly sessionDirectory: string;
  /** The fresh id the target conversation is written under. */
  readonly conversationId: string;
  readonly at: string;
  /** `false` carries shell commands as text: the fallback when the target CLI lacks its shell tool. */
  readonly nativeShell?: boolean;
}

/** The conversion, ready to be checked and written. */
export interface ConversationConverted {
  readonly kind: 'convert';
  /** The target conversation's fresh id. */
  readonly conversationId: string;
  readonly provenance: TranscriptProvenance;
  /** The target transcript: its path in the target home and its whole text. */
  readonly transcript: { readonly file: string; readonly text: string };
  /** Attachments to save first, with absolute paths. */
  readonly files: readonly { readonly file: string; readonly data: string }[];
  readonly summary: ConversionSummary;
  /** Renders the same conversion again for another place — the validation run's throwaway copy. */
  readonly render: (place: ConversionPlace) => ConversionResult;
}

/** Why the conversation cannot be converted, in words a person reads. */
export interface ConversationNotConvertible {
  readonly kind: 'unconvertible';
  readonly reason: string;
}

export type ConversationConvert = ConversationConverted | ConversationNotConvertible;

/** Where a rendering of the conversion will live. */
export interface ConversionPlace {
  readonly cwd: string;
  readonly conversationId: string;
  /** Codex: the provider the place's configuration selects, overriding the target login's. */
  readonly modelProvider?: string;
}

const NOTHING_CHANGED = 'Nothing was changed.';

const unconvertible = (reason: string): ConversationNotConvertible => ({
  kind: 'unconvertible',
  reason: `${reason} ${NOTHING_CHANGED}`,
});

export function planConversationConvert(request: ConversationConvertRequest): ConversationConvert {
  const { source, targetHome } = request;
  if (request.sourceHarness === request.targetHarness)
    return unconvertible(
      `${request.targetAgent} runs the same harness as this session, so its conversation can be resumed there as it is — move it without converting.`,
    );
  if (source === undefined || source.file === undefined || source.harnessSessionId === undefined)
    return unconvertible(
      "Ferretry hasn't matched this session to its conversation yet, so there's nothing to convert.",
    );
  if (request.sourceText === undefined)
    return unconvertible(`The conversation file ${source.file} is gone, so there's nothing to convert.`);
  if (targetHome === undefined)
    return unconvertible(
      `${request.targetAgent} doesn't say where it keeps its conversations, so a converted one can't be written there.`,
    );
  const attachmentDirectory = join(request.sessionDirectory, CONVERSION_ATTACHMENTS, request.conversationId);
  const sourceText = request.sourceText;
  const render = (place: ConversionPlace): ConversionResult =>
    convertConversation({
      source: { harness: request.sourceHarness, text: sourceText, documents: request.documents },
      target: {
        harness: request.targetHarness,
        version: request.targetVersion,
        conversationId: place.conversationId,
        cwd: place.cwd,
        contextWindow: request.targetWindow,
        ...(request.nativeShell === undefined ? {} : { nativeShell: request.nativeShell }),
        ...(request.targetFormat === undefined ? {} : { format: request.targetFormat }),
        ...(request.targetModel === undefined ? {} : { model: request.targetModel }),
        ...(request.targetHarness === 'codex'
          ? { workspaceRoots: [codexCorrelationArguments(request.sessionDirectory)[1] as string] }
          : {}),
        ...((place.modelProvider ?? request.targetModelProvider) === undefined
          ? {}
          : { modelProvider: place.modelProvider ?? request.targetModelProvider }),
      },
      attachmentDirectory,
      at: request.at,
    });
  const converted = render({ cwd: request.cwd, conversationId: request.conversationId });
  if (converted.kind === 'refused') return unconvertible(converted.reason);
  const file =
    request.targetHarness === 'claude'
      ? claudeTranscriptFile(targetHome, request.cwd, request.conversationId)
      : join(targetHome, codexRolloutRelativePath(request.conversationId, request.at));
  const provenance: TranscriptProvenance =
    request.targetHarness === 'claude'
      ? {
          v: 1,
          home: targetHome,
          harnessSessionId: request.conversationId,
          identity: 'minted',
          file,
          resolvedAt: request.at,
        }
      : {
          v: 1,
          home: targetHome,
          harnessSessionId: request.conversationId,
          identity: 'adopted',
          correlationToken: request.sessionDirectory,
          file,
          resolvedAt: request.at,
        };
  return {
    kind: 'convert',
    conversationId: request.conversationId,
    provenance,
    transcript: { file, text: converted.transcript },
    files: converted.files.map((attachment: ConvertedFile) => ({
      file: join(attachmentDirectory, attachment.name),
      data: attachment.data,
    })),
    summary: converted.summary,
    render,
  };
}

/**
 * What a validation run found. `missingTools` names native tools the history uses that the target CLI
 * did not declare — the one failure a text-only rendering can get past.
 */
export type ConversionCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly missingTools?: readonly string[] };

/**
 * Proves the target CLI accepts a conversion before anything is switched: it resumes a rendering of
 * it in a throwaway home against a loopback model, and the run counts only when the history reached
 * that model in order. No real login, no network, no tokens.
 */
export interface ConversionCheckPort {
  check(request: {
    readonly harness: Harness;
    /** The harness CLI itself — the binary the target runtime's wrapper runs. */
    readonly executable: string;
    /** The model the target runtime will run, so the CLI declares the tools it will really have. */
    readonly model?: string;
    readonly render: (place: ConversionPlace) => ConversionResult;
  }): Promise<ConversionCheck>;
}

/** The version a harness CLI reports, read from its `--version`. */
export interface HarnessVersionPort {
  version(executable: string): Promise<string | undefined>;
}

/**
 * What rollout format an installed Codex writes, found by running it once rather than by its number.
 * Asked only about a version the converter's table does not list; the answer is remembered per binary
 * and version, so a person who keeps one Codex pays for one probe.
 */
export interface RolloutFormatPort {
  classify(executable: string, version: string): Promise<RolloutFormatVerdict>;
}

/** Whether a target's rollout format has to be probed: a Codex whose version the converter's table does not list. */
export const needsRolloutFormatProbe = (harness: Harness, version: string | undefined): version is string =>
  harness === 'codex' && version !== undefined && harnessVersionRefusal('codex', version, 'target') !== undefined;

/**
 * The model provider a Codex home's `config.toml` selects at top level, or `undefined` when it names
 * none (Codex then runs its built-in `openai`). Read the same way the launch reads `service_tier`: a
 * top-level key before the first table, quoted either way.
 */
export function codexModelProvider(document: string | undefined): string | undefined {
  for (const line of (document ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) return undefined;
    const match = /^model_provider\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/u.exec(trimmed);
    const provider = (match?.[1] ?? match?.[2])?.trim();
    if (provider !== undefined && provider !== '') return provider;
  }
  return undefined;
}
