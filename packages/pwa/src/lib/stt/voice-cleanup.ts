/**
 * The machine's dictation cleanup settings as `voice.yaml` holds them (`postProcessing`): the style, the
 * two editable prompts, and whether the session's recent messages go along as read-only reference.
 *
 * The file is read and edited as TEXT, so the owner's comments and key order survive and only the keys
 * that change are rewritten. A prompt that is empty, or the shipped default, is not kept in the file:
 * deleting the key IS "Reset to default". The daemon's fixed guard wraps whichever prompt runs; nothing
 * here can switch it off.
 */

import { editConfigText, readConfigText } from '@ferretry/fleet/config-text';
import {
  configSchemaModeline,
  DEFAULT_VOICE_CLEANUP_PROMPTS,
  MAX_VOICE_PROMPT_CHARS,
  type VoiceCleanupStyle,
  VoiceConfigSchema,
} from '@ferretry/protocol';

export type EditableCleanupStyle = Exclude<VoiceCleanupStyle, 'off'>;

export const MAX_CONVERSATION_MESSAGES = 10;
const DEFAULT_CONVERSATION_MESSAGES = 8;
export { DEFAULT_VOICE_CLEANUP_PROMPTS, MAX_VOICE_PROMPT_CHARS };

export interface VoiceCleanup {
  readonly style: VoiceCleanupStyle;
  /** The person's own wording; a style not listed runs the shipped default. */
  readonly prompts: Readonly<Partial<Record<EditableCleanupStyle, string>>>;
  readonly useConversation: boolean;
  readonly conversationMessages: number;
}

export const DEFAULT_VOICE_CLEANUP: VoiceCleanup = Object.freeze({
  style: 'fix',
  prompts: Object.freeze({}),
  useConversation: false,
  conversationMessages: DEFAULT_CONVERSATION_MESSAGES,
});

/** A change to ask for. A `null` prompt is "Reset to default". */
export interface VoiceCleanupPatch {
  readonly style?: VoiceCleanupStyle;
  readonly prompts?: Readonly<Partial<Record<EditableCleanupStyle, string | null>>>;
  readonly useConversation?: boolean;
  readonly conversationMessages?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The text a style runs: the person's prompt, else the shipped default. */
export const promptFor = (cleanup: VoiceCleanup, style: EditableCleanupStyle): string =>
  cleanup.prompts[style] ?? DEFAULT_VOICE_CLEANUP_PROMPTS[style];

const parsed = (text: string): { readonly raw: Record<string, unknown>; readonly cleanup: VoiceCleanup } | null => {
  const read = readConfigText(text);
  if (!read.ok) return null;
  const checked = VoiceConfigSchema.safeParse(read.read.value);
  if (!checked.success) return null;
  const { style, prompts, useConversation, conversationMessages } = checked.data.postProcessing;
  const raw = isRecord(read.read.value) ? read.read.value : {};
  return { raw, cleanup: { style, prompts, useConversation, conversationMessages } };
};

/** The cleanup settings `voice.yaml` names, or `null` when the file does not parse or check. */
export const readVoiceCleanup = (text: string): VoiceCleanup | null => parsed(text)?.cleanup ?? null;

const withoutKey = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

/** `voice.yaml` with the change made, or `null` when the file cannot be edited (it does not check). */
export const withVoiceCleanup = (text: string, patch: VoiceCleanupPatch): string | null => {
  const before = parsed(text);
  if (before === null) return null;
  const { raw } = before;
  const rawPost = isRecord(raw.postProcessing) ? raw.postProcessing : {};
  let post: Record<string, unknown> = { ...rawPost };

  // A value equal to its default is written only where the file already says something about it.
  const setField = (key: string, value: unknown, fallback: unknown): void => {
    if (key in rawPost || value !== fallback) post = { ...post, [key]: value };
  };
  if (patch.style !== undefined) setField('style', patch.style, DEFAULT_VOICE_CLEANUP.style);
  if (patch.useConversation !== undefined) {
    setField('useConversation', patch.useConversation, DEFAULT_VOICE_CLEANUP.useConversation);
  }
  if (patch.conversationMessages !== undefined) {
    const count = Math.min(MAX_CONVERSATION_MESSAGES, Math.max(1, Math.round(patch.conversationMessages)));
    setField('conversationMessages', count, DEFAULT_CONVERSATION_MESSAGES);
  }
  if (patch.prompts !== undefined) {
    let prompts: Record<string, unknown> = isRecord(rawPost.prompts) ? { ...rawPost.prompts } : {};
    for (const style of ['fix', 'polish'] as const) {
      const next = patch.prompts[style];
      if (next === undefined) continue;
      const trimmed = next === null ? '' : next.trim().slice(0, MAX_VOICE_PROMPT_CHARS);
      prompts =
        trimmed === '' || trimmed === DEFAULT_VOICE_CLEANUP_PROMPTS[style]
          ? withoutKey(prompts, style)
          : { ...prompts, [style]: trimmed };
    }
    post = Object.keys(prompts).length === 0 ? withoutKey(post, 'prompts') : { ...post, prompts };
  }

  const target = Object.keys(post).length === 0 ? withoutKey(raw, 'postProcessing') : { ...raw, postProcessing: post };
  const next = editConfigText(text, target, raw, configSchemaModeline({ kind: 'voice' }));
  return readVoiceCleanup(next) === null ? null : next;
};
