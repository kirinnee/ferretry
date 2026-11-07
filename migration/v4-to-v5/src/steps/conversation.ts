/**
 * Conversation: what a ferret was told, sent, asked and is typing, and the key that signs links to its messages.
 *
 * Two halves, on purpose (lead, 2026-11-07). The v5 Conversation state on `rebuild/5.0` is the contract skeleton, and
 * the port (`origin/rebuild/fix-port-conversation-r1`) changes most of it. So this step WRITES only what both agree on
 * and only READS the rest:
 *
 * Written (identical on both):
 * - `state/session-message-token.key` → `state/conversation/message-token.key`, byte for byte, never opened.
 * - `state/sessions/<sid>/turns/` → `state/conversation/<sid>/turns/` (opaque), every file byte for byte.
 * - `state/shared-drafts/<sid>.json` → `state/conversation/<sid>/drafts` (opaque): the port's one document per ferret,
 *   `{chat, items}`, each snapshot parsed by v5's `DraftSnapshotSchema` (`sessionId` becomes `ferret`).
 * - `state/conversation/links.json` from every ferret v4 kept from an existing conversation (`transcript.identity`
 *   `adopted`): v4 has no ledger of its own, and that identity is exactly "read from the harness's own file".
 *
 * Read and checked, NOT written (their v5 shape changes on the port): queue, sends, answers, inbox, outbox, the open
 * question, attachments and renders. So the step reports `pending` until the port lands and the mapping is added.
 */
import {
  DraftSnapshotSchema,
  DRAFTS_STATE,
  LINKS_STATE,
  LinksFileSchema,
  MESSAGE_TOKEN_KEY_STATE,
  TURNS_STATE,
} from '@ferretry/plugin-conversation/contract';
import { chmod, mkdir, readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { KeptItem, StepReport } from '../report.ts';
import { moveSealed } from '../sealed.ts';
import {
  entry,
  foldV4Queue,
  latestV4Answers,
  latestV4Sends,
  names,
  readJson,
  readJsonl,
  sharedDraftsFolder,
  V4AgendaId,
  V4AnswerReceipt,
  V4AskedQuestion,
  V4AttachmentManifest,
  V4InboxLine,
  V4InputError,
  V4_MESSAGE_TOKEN_KEY,
  V4_MESSAGE_TOKEN_KEY_MODE,
  V4OutboxLine,
  V4QueueEvent,
  V4RenderMeta,
  V4SendLine,
  V4SharedDraft,
  type V4Reader,
} from '../v4/conversation.ts';
import { configs, json, State } from '../v4/ferrets.ts';
import type { Step, StepContext } from './index.ts';

/** `state/conversation/` — the plugin's state folder (§9.2); the declarations' paths are relative to it. */
export const V5_CONVERSATION = 'state/conversation';
const at = (path: string, ferret?: string) =>
  join(V5_CONVERSATION, ferret === undefined ? path : path.replace('*', ferret));
export const V5_MESSAGE_TOKEN_KEY_FILE = at(MESSAGE_TOKEN_KEY_STATE.path);
export const V5_LINKS_FILE = at(LINKS_STATE.path);
export const v5TurnsFolder = (ferret: string) => at(TURNS_STATE.path, ferret);
export const v5DraftsFile = (ferret: string) => at(DRAFTS_STATE.path, ferret);

/** Waits for this before the second half is mapped; named in the report. */
export const CONVERSATION_PORT = 'origin/rebuild/fix-port-conversation-r1';

/**
 * The inside of the opaque `drafts` file, as the port's `StateDraftRepository` reads it: the chat draft, and one reply
 * draft per agenda item keyed by its id. `rebuild/5.0` declares the file opaque, so this layout satisfies both.
 */
export const DraftsDocumentSchema = z.strictObject({
  chat: DraftSnapshotSchema.optional(),
  items: z.record(z.string().regex(/^A[1-9][0-9]*$/u), DraftSnapshotSchema),
});

const ENDED = new Set(['completed', 'failed', 'stalled', 'stopped', 'interrupted']);

const PENDING = [
  'queue (v4 event log; port keeps the events, 5.0 declares folded QueuedMessage lines)',
  'sends (v4 internal ledger lines; port keeps them, 5.0 declares the SendRecord wire view)',
  'answers (v4 receipts; port keeps them, 5.0 declares AnswerRecord with the answer labels v4 never stored)',
  'inbox/outbox (no 5.0 declaration; the port adds inbox.jsonl and outbox.jsonl)',
  'the open question (5.0 declares QuestionSchema; the port reads the raw hook payload from question.json)',
  'attachments (5.0: <ferret>/attachments; port: attachments/<ferret>~<id>.original|.manifest)',
  'renders (5.0: opaque renders; port: renders/<id>.json + <id>.payload, author.ferret)',
] as const;

export const conversationStep: Step = {
  id: 'conversation',
  title: 'Conversation (message queue, shared drafts, turns, links, message-token key)',
  owner: ['plugin-conversation'],
  reads: [
    'state/sessions/<sid>/turns/',
    'state/sessions/<sid>/channel/{queue,sends,answers,inbox,outbox}.jsonl',
    'state/sessions/<sid>/question-asked.json',
    'state/sessions/<sid>/config.json (transcript.identity adopted → links)',
    'state/shared-drafts/<sid>.json, <sid>.items/<askId>.json',
    'state/attachments/<daemonId>/<sid>/<attachmentId>/manifest.json (original never opened)',
    'state/renders/<shard>/<id>.json',
  ],
  sealed: ['state/session-message-token.key'],
  notCarried: [
    { what: 'search and finder caches', why: 'v5 rebuilds them' },
    { what: 'last-snapshot.txt', why: 'the final pane frame of an ended ferret; no v5 file holds it' },
    { what: 'question-asked.json of ended ferrets', why: 'it describes a form that is gone' },
    {
      what: 'per-ferret pins.json and state/agent-pins.json',
      why: 'M5 gives pins to Conversation, but neither rebuild/5.0 nor the Conversation port declares a pins file',
    },
    {
      what: 'channel/queued-<sendId>.md and .by.json',
      why: 'no v5 state declaration on rebuild/5.0 or the port (the port names them by path only)',
    },
    { what: 'media/', why: 'no v5 state declaration on rebuild/5.0 or the port' },
    { what: 'shared drafts of sessions with no config.json', why: 'they belong to no ferret' },
    { what: 'links inside turns/', why: 'never followed or re-made' },
    {
      what: 'a final log line with no newline that does not parse',
      why: 'a crash during the v4 append; v4 itself skipped it',
    },
  ],
  async run(ctx: StepContext): Promise<StepReport> {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried };
    const reader: V4Reader = { home: ctx.v4.home };
    try {
      const sealed: { file: string; bytes: number }[] = [];
      const counts = {
        turnFiles: 0,
        turnLinks: 0,
        chatDrafts: 0,
        itemDrafts: 0,
        orphanDrafts: 0,
        links: 0,
        queued: 0,
        sends: 0,
        answers: 0,
        inbox: 0,
        outbox: 0,
        questions: 0,
        attachments: 0,
        renders: 0,
      };

      // The key: metadata only (lstat), then moved unopened. v4 refused a key that was not 0600, and so would v5.
      const key = join(ctx.v4.state, V4_MESSAGE_TOKEN_KEY);
      const keyInfo = await entry(key);
      if (keyInfo !== undefined) {
        if (!keyInfo.isFile())
          throw new V4InputError('sealed key is not a regular file', `state/${V4_MESSAGE_TOKEN_KEY}`);
        if ((keyInfo.mode & 0o777) !== V4_MESSAGE_TOKEN_KEY_MODE)
          throw new V4InputError('sealed key is not mode 0600', `state/${V4_MESSAGE_TOKEN_KEY}`);
        if (!ctx.dryRun) await moveSealed(key, ctx.v5.resolve(V5_MESSAGE_TOKEN_KEY_FILE));
        sealed.push({ file: V5_MESSAGE_TOKEN_KEY_FILE, bytes: keyInfo.size });
      }

      const copyTree = async (from: string, to: string): Promise<void> => {
        const source = await entry(from);
        if (source === undefined) return;
        if (source.isSymbolicLink()) {
          counts.turnLinks++;
          return;
        }
        if (source.isDirectory()) {
          if (!ctx.dryRun) await mkdir(ctx.v5.resolve(to), { recursive: true, mode: 0o700 });
          for (const name of (await readdir(from)).sort()) await copyTree(join(from, name), join(to, name));
          if (!ctx.dryRun) {
            await chmod(ctx.v5.resolve(to), source.mode & 0o777);
            await utimes(ctx.v5.resolve(to), source.atime, source.mtime);
          }
          return;
        }
        if (!source.isFile())
          throw new V4InputError('turn entry is not a file or folder', from.slice(ctx.v4.home.length + 1));
        if (!ctx.dryRun) await moveSealed(from, ctx.v5.resolve(to));
        counts.turnFiles++;
      };

      const sessions = await configs(ctx.v4.sessions);
      const known = new Set(sessions.map(config => config.id));
      const links: z.input<typeof LinksFileSchema>['links'] = [];
      const draftsFolder = sharedDraftsFolder(ctx.v4.state);

      for (const config of sessions) {
        const folder = join(ctx.v4.sessions, config.id);
        const channel = join(folder, 'channel');
        const state = await json(join(folder, 'state.json'), State);
        const ended = state === undefined || ENDED.has(state.status);

        // Turns: opaque, the same on both branches.
        const turns = join(folder, 'turns');
        const turnsInfo = await entry(turns);
        if (turnsInfo !== undefined) {
          if (!turnsInfo.isDirectory())
            throw new V4InputError('turns is not a folder', `state/sessions/${config.id}/turns`);
          await copyTree(turns, v5TurnsFolder(config.id));
        }

        // The chat draft, through v5's own snapshot schema.
        const chat = await readJson(reader, join(draftsFolder, `${config.id}.json`), V4SharedDraft);
        if (chat !== undefined && (chat.sessionId !== config.id || chat.slot !== undefined))
          throw new V4InputError('shared draft names another session or slot', `state/shared-drafts/${config.id}.json`);
        // Agenda reply drafts, keyed by the ask id. v5 Asks numbers asks per ferret exactly as v4 did (the agenda
        // files are carried with their ids), so `A<n>` on this ferret's board is the same ask in v5.
        const items: Record<string, z.input<typeof DraftSnapshotSchema>> = {};
        const itemsFolder = join(draftsFolder, `${config.id}.items`);
        for (const item of await names(reader, itemsFolder)) {
          if (item.folder || !item.name.endsWith('.json')) continue;
          const slot = item.name.slice(0, -'.json'.length);
          if (!V4AgendaId.safeParse(slot).success) continue;
          const draft = await readJson(reader, join(itemsFolder, item.name), V4SharedDraft);
          if (draft === undefined) continue;
          if (draft.sessionId !== config.id || draft.slot !== slot)
            throw new V4InputError(
              'agenda draft names another session or slot',
              `state/shared-drafts/${config.id}.items/${item.name}`,
            );
          const { sessionId, ...rest } = draft;
          items[slot] = DraftSnapshotSchema.parse({ ...rest, ferret: sessionId });
          counts.itemDrafts++;
        }
        if (chat !== undefined || Object.keys(items).length > 0) {
          const document = DraftsDocumentSchema.parse({
            ...(chat === undefined
              ? {}
              : (({ sessionId, slot: _slot, ...rest }) => ({
                  chat: DraftSnapshotSchema.parse({ ...rest, ferret: sessionId }),
                }))(chat)),
            items,
          });
          await ctx.v5.json({ path: v5DraftsFile(config.id), format: 1, schema: DraftsDocumentSchema }, document);
          if (chat !== undefined) counts.chatDrafts++;
        }

        // Links: a kept (adopted) conversation is read where its harness keeps it.
        const transcript = config.transcript;
        if (transcript?.identity === 'adopted' && transcript.harnessSessionId !== undefined)
          links.push({
            id: transcript.harnessSessionId,
            harness: config.harness === 'claude' ? 'claude-code' : 'codex',
            ferret: config.id,
            linkedAt: transcript.resolvedAt ?? config.createdAt,
          });

        // Read and checked, not written: their v5 shape is the port's.
        counts.queued += foldV4Queue(await readJsonl(reader, join(channel, 'queue.jsonl'), V4QueueEvent)).length;
        counts.sends += latestV4Sends(await readJsonl(reader, join(channel, 'sends.jsonl'), V4SendLine)).length;
        counts.answers += latestV4Answers(
          await readJsonl(reader, join(channel, 'answers.jsonl'), V4AnswerReceipt),
        ).length;
        counts.inbox += (await readJsonl(reader, join(channel, 'inbox.jsonl'), V4InboxLine)).length;
        counts.outbox += (await readJsonl(reader, join(channel, 'outbox.jsonl'), V4OutboxLine)).length;
        if (!ended && (await readJson(reader, join(folder, 'question-asked.json'), V4AskedQuestion)) !== undefined)
          counts.questions++;
      }

      for (const item of await names(reader, draftsFolder))
        if (!item.folder && item.name.endsWith('.json') && !known.has(item.name.slice(0, -'.json'.length)))
          counts.orphanDrafts++;

      if (links.length > 0) {
        const document = LinksFileSchema.parse({ format: 1, links });
        await ctx.v5.json({ path: V5_LINKS_FILE, format: 1, schema: LinksFileSchema }, document);
        counts.links = document.links.length;
      }

      // Attachments: manifests parsed, originals only checked to exist (never opened).
      const attachments = join(ctx.v4.state, 'attachments');
      for (const daemon of await names(reader, attachments)) {
        if (!daemon.folder) continue;
        for (const session of await names(reader, join(attachments, daemon.name))) {
          if (!session.folder) continue;
          for (const attachment of await names(reader, join(attachments, daemon.name, session.name))) {
            if (!attachment.folder) continue;
            const where = join(attachments, daemon.name, session.name, attachment.name);
            const label = `state/attachments/<daemonId>/${session.name}/${attachment.name}`;
            const manifest = await readJson(reader, join(where, 'manifest.json'), V4AttachmentManifest);
            if (manifest === undefined) continue;
            if (manifest.id !== attachment.name) throw new V4InputError('attachment manifest names another id', label);
            if (!(await entry(join(where, 'original')))?.isFile())
              throw new V4InputError('attachment has no original file', label);
            counts.attachments++;
          }
        }
      }

      // Renders: meta parsed, payload only checked to exist.
      const renders = join(ctx.v4.state, 'renders');
      for (const shard of await names(reader, renders)) {
        if (!shard.folder) continue;
        for (const file of await names(reader, join(renders, shard.name))) {
          if (file.folder || !file.name.endsWith('.json')) continue;
          const id = file.name.slice(0, -'.json'.length);
          const label = `state/renders/${shard.name}/${file.name}`;
          const meta = await readJson(reader, join(renders, shard.name, file.name), V4RenderMeta);
          if (meta === undefined) continue;
          if (meta.id !== id || id.slice(0, 2) !== shard.name)
            throw new V4InputError('render meta names another id or shard', label);
          if (!(await entry(join(renders, shard.name, `${id}.payload`)))?.isFile())
            throw new V4InputError('render has no payload file', label);
          counts.renders++;
        }
      }

      const kept: KeptItem[] = [
        { what: 'message-token keys moved unopened', count: sealed.length },
        { what: 'turn files copied byte for byte', count: counts.turnFiles },
        { what: 'chat drafts', count: counts.chatDrafts },
        { what: 'agenda reply drafts', count: counts.itemDrafts },
        { what: 'conversation links', count: counts.links },
      ];
      const read =
        `queue messages ${counts.queued}, sends ${counts.sends}, answer receipts ${counts.answers}, ` +
        `inbox lines ${counts.inbox}, outbox lines ${counts.outbox}, open questions ${counts.questions}, ` +
        `attachments ${counts.attachments}, renders ${counts.renders}`;
      return {
        ...base,
        status: 'pending',
        note:
          `waits for the Conversation port (${CONVERSATION_PORT}) to land on rebuild/5.0; ` +
          `read and checked but not written: ${read}. Shape changes on the port: ${PENDING.join('; ')}` +
          (counts.turnLinks > 0 ? `; ${counts.turnLinks} link(s) in turns omitted` : '') +
          (counts.orphanDrafts > 0 ? `; ${counts.orphanDrafts} orphan draft(s) omitted` : '') +
          (ctx.dryRun ? '; dry run: nothing written' : ''),
        kept,
        sealed,
      };
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        note:
          error instanceof V4InputError
            ? error.message
            : 'cannot convert conversation input: invalid data or an unavailable file',
        kept: [],
        sealed: [],
      };
    }
  },
};
