import { type ConversionPreview, type MigrationConversation, MigrationConversationSchema } from '@ferretry/protocol';
import { type IProgress, NO_PROGRESS, withStep } from '../progress/index.ts';
import type { SessionPresenter } from '../session/presenter.ts';
import type { IMigrationGateway } from './ports.ts';

/** Flags accepted by `fy migrate`. */
export interface MigrationCommandOptions {
  readonly agent: string;
  readonly model?: string;
  readonly allowContextDowngrade?: boolean;
  readonly forceInflight?: boolean;
  /** `resume` (the daemon's default), `fresh`, `previous` or `convert`; see `MigrationConversation`. */
  readonly conversation?: string;
  /** Shorthand for `--conversation convert`: a move onto the other harness. */
  readonly convert?: boolean;
  /** With `--convert`, print the conversion preview and change nothing. */
  readonly preview?: boolean;
  readonly requestId?: string;
  readonly json?: boolean;
}

/** Moves one session to another account through the daemon's mandatory preflight gate. */
export class MigrationController {
  constructor(
    private readonly gateway: IMigrationGateway,
    private readonly presenter: SessionPresenter,
    private readonly progress: IProgress = NO_PROGRESS,
  ) {}

  async execute(reference: string, options: MigrationCommandOptions): Promise<void> {
    const id = reference.trim();
    if (id === '') throw new Error('a session id or callsign is required');
    const agent = options.agent.trim();
    if (agent === '') throw new Error('--agent must name a fleet account');
    const model = optionalText(options.model);
    const requestId = optionalText(options.requestId);
    if (options.requestId !== undefined && requestId === undefined) throw new Error('--request-id must not be blank');
    const conversation = conversationChoice(options.conversation, options.convert === true);
    if (options.preview === true) {
      if (conversation !== 'convert') throw new Error('--preview needs --convert: only a conversion has a preview');
      const preview = await withStep(
        this.progress,
        'Previewing the conversion',
        async () => await this.gateway.conversionPreview(id, agent, model),
      );
      if (options.json === true) this.presenter.json(preview);
      else this.presenter.lines(renderConversionPreview(preview));
      return;
    }

    const view = await withStep(
      this.progress,
      `Moving ${id} to ${agent}`,
      async () =>
        await this.gateway.migrate(
          id,
          agent,
          model,
          options.allowContextDowngrade === true,
          requestId,
          options.forceInflight === true,
          ...(conversation === undefined ? [] : [conversation]),
        ),
    );
    this.presenter.view(view, options.json === true);
  }
}

/** The `--conversation` choice, refused before the destructive call when it is not one the daemon knows. */
function conversationChoice(value: string | undefined, convert: boolean): MigrationConversation | undefined {
  if (value === undefined) return convert ? 'convert' : undefined;
  const parsed = MigrationConversationSchema.safeParse(value.trim());
  if (!parsed.success)
    throw new Error(`--conversation must be one of ${MigrationConversationSchema.options.join(', ')}`);
  if (convert && parsed.data !== 'convert')
    throw new Error(`--convert and --conversation ${parsed.data} ask for different things; pass one of them`);
  return parsed.data;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
const verb = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/** A conversion preview as the lines a person reads before running the move without `--preview`. */
export function renderConversionPreview(preview: ConversionPreview): readonly string[] {
  if (preview.kind === 'refused') return [`Can't convert onto ${preview.targetAgent}: ${preview.reason}`];
  const summary = preview.summary;
  const target = summary.targetHarness === 'codex' ? 'Codex' : 'Claude Code';
  const source = summary.sourceHarness === 'codex' ? 'Codex' : 'Claude Code';
  const dropped = [
    summary.dropped.reasoning > 0 ? `thinking (${summary.dropped.reasoning})` : '',
    summary.dropped.sidechains > 0 ? `subagent work (${summary.dropped.sidechains})` : '',
    summary.dropped.internal > 0 ? `harness notes (${summary.dropped.internal})` : '',
  ].filter(item => item !== '');
  return [
    `Moving onto ${preview.targetAgent} (${preview.targetModel}, ${target} ${summary.targetVersion}), ` +
      `converted from ${source}${summary.sourceVersion === undefined ? '' : ` ${summary.sourceVersion}`}.`,
    summary.omittedTurns === 0
      ? `All ${plural(summary.turns, 'turn')} will move.`
      : `${summary.keptTurns} of ${plural(summary.turns, 'turn')} will move; the ${summary.omittedTurns} oldest are left out to fit.`,
    ...(summary.formatNote === undefined ? [] : [summary.formatNote]),
    ...(summary.cutNewest ? ['The newest turn is too long and will be shortened.'] : []),
    `${plural(summary.nativeToolCalls, 'shell command')} ${verb(summary.nativeToolCalls, 'carries', 'carry')} over as ${target} commands; ` +
      `${plural(summary.toolCallsAsText, 'other tool call')} ${verb(summary.toolCallsAsText, 'becomes a', 'become')} short text ${summary.toolCallsAsText === 1 ? 'note' : 'notes'}.`,
    ...(summary.attachments > 0
      ? [
          `${plural(summary.attachments, 'attachment')} ${verb(summary.attachments, 'carries', 'carry')} over as file references.`,
        ]
      : []),
    ...(dropped.length > 0 ? [`Not carried: ${dropped.join(', ')}.`] : []),
    ...(summary.dropped.compactions > 0 ? ['Earlier history was already compacted; its summary carries over.'] : []),
    'Run the same command without --preview to move it. The original conversation stays on disk.',
  ];
}

/** Trims an optional CLI value, treating blank optional text as absent. */
function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}
