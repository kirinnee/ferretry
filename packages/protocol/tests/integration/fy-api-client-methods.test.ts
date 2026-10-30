import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { type FyApiClient, FyTransportError } from '../../src/adapters/fy-api-client.ts';
import { FY_REQUEST_ID_HEADER } from '../../src/lib/client.ts';
import {
  analyticsResponse,
  cgroupConfigView,
  daemonUpdateView,
  fyEvent,
  harnessUpdateView,
  healthView,
  pwaConfigView,
  scratchPlanView,
  scratchSweepView,
  sendRecord,
  sendResult,
  sessionAttachTarget,
  sessionView,
  usageFeedView,
  wardenAgendaView,
  wardenConfigView,
  wardenInvestigateView,
  wardenLeaveView,
  wardenRunView,
  wardenStatusView,
} from '../fixtures.ts';
import { BASE_URL, connectClient, headersOf, jsonBodyOf } from './client-harness.ts';
import { captureError, emptyResponse, jsonResponse, QueuedHttpTransport, textResponse } from './fakes.ts';

/**
 * Every typed method is a thin delegation to `request()`. What can break in a delegation is the
 * verb, the path (including parameter encoding), the request schema applied to the body, and the
 * response schema applied to the payload — so the table pins all four for each one.
 */
interface MethodCase {
  /** Test name suffix; also the delegation being pinned. */
  readonly name: string;
  readonly invoke: (client: FyApiClient) => Promise<unknown>;
  readonly verb: string;
  readonly path: string;
  /** Expected JSON request body, or undefined when the method must not send one. */
  readonly body?: unknown;
  /** Caller-supplied idempotency key, when a mutation must preserve it. */
  readonly requestId?: string;
  /** Fresh response per use — a Response body may only be consumed once. */
  readonly response: () => Response;
  readonly expected: unknown;
}

const SESSION_ID = 'session-1';
const SNAPSHOT_TEXT = 'pane line one\npane line two';
const LOG_TEXT = 'turn 1 log output';
const WARDEN_REPORT = '# Warden report\n\nVerdict: LEAVE\n';
const NAME_SUGGESTIONS = ['Fix Transcript Scrolling', 'Port Protocol Client', 'Cover Typed Methods'];
const FOREIGN_HISTORY = { conversations: [], skipped: [] };
const FOREIGN_CONVERSATION = {
  conversation: {
    id: 'import-1',
    harness: 'claude',
    title: 'Imported read-only conversation',
    eventCount: 2,
    startedAt: '2026-08-05T00:00:00.000Z',
    readOnly: true,
  },
  messages: [{ id: 'record-1', role: 'user', text: 'A real imported message.' }],
};

/** One page of the addressable conversation: a redacted row, its coordinate and its evidence. */
const TRANSCRIPT_PAGE = {
  v: 1,
  sessionId: SESSION_ID,
  messages: [
    {
      point: { v: 1, byteOffset: 0, blockIndex: 0 },
      role: 'assistant',
      text: 'The token is [redacted] and the plan stands.',
      timestamp: '2026-08-06T07:00:00.000Z',
      selectionBinding: 'selection-binding-1',
    },
  ],
  nextCursor: 'message-cursor-1',
};

const sessionResponse = (): Response => jsonResponse(sessionView);

const CASES: readonly MethodCase[] = [
  {
    name: 'health',
    invoke: client => client.health(),
    verb: 'GET',
    path: '/v1/health',
    response: () => jsonResponse(healthView),
    expected: healthView,
  },
  {
    name: 'wardenStatus',
    invoke: client => client.wardenStatus(),
    verb: 'GET',
    path: '/v1/warden/status',
    response: () => jsonResponse(wardenStatusView),
    expected: wardenStatusView,
  },
  {
    name: 'wardenVerdicts',
    invoke: client => client.wardenVerdicts(),
    verb: 'GET',
    path: '/v1/warden/verdicts',
    response: () => jsonResponse([]),
    expected: [],
  },
  {
    name: 'wardenReport',
    invoke: client => client.wardenReport('/state/warden/reports/report 1.md'),
    verb: 'GET',
    path: '/v1/warden/report?path=%2Fstate%2Fwarden%2Freports%2Freport%201.md',
    response: () => textResponse(WARDEN_REPORT),
    expected: WARDEN_REPORT,
  },
  {
    name: 'wardenRun without a spawn',
    invoke: client => client.wardenRun(),
    verb: 'POST',
    path: '/v1/warden/run',
    body: { spawn: false },
    response: () => jsonResponse(wardenRunView),
    expected: wardenRunView,
  },
  {
    name: 'wardenRun with a spawn',
    invoke: client => client.wardenRun(true),
    verb: 'POST',
    path: '/v1/warden/run',
    body: { spawn: true },
    response: () => jsonResponse(wardenRunView),
    expected: wardenRunView,
  },
  {
    name: 'wardenConfig',
    invoke: client => client.wardenConfig(),
    verb: 'GET',
    path: '/v1/warden/config',
    response: () => jsonResponse(wardenConfigView),
    expected: wardenConfigView,
  },
  {
    name: 'updateWardenConfig',
    invoke: client => client.updateWardenConfig({ enabled: false, intervalMinutes: 10 }),
    verb: 'PATCH',
    path: '/v1/warden/config',
    body: { enabled: false, intervalMinutes: 10 },
    response: () => jsonResponse(wardenConfigView),
    expected: wardenConfigView,
  },
  {
    name: 'wardenAgenda',
    invoke: client => client.wardenAgenda(),
    verb: 'GET',
    path: '/v1/warden/attention',
    response: () => jsonResponse(wardenAgendaView),
    expected: wardenAgendaView,
  },
  {
    name: 'wardenInvestigate',
    invoke: client => client.wardenInvestigate({ sessionId: 'session-1', note: 'CI went red' }),
    verb: 'POST',
    path: '/v1/warden/investigate',
    body: { sessionId: 'session-1', note: 'CI went red' },
    response: () => jsonResponse(wardenInvestigateView),
    expected: wardenInvestigateView,
  },
  {
    name: 'wardenLeave',
    invoke: client => client.wardenLeave({ sessionId: 'session-1', duration: '4h' }),
    verb: 'POST',
    path: '/v1/warden/leave',
    body: { sessionId: 'session-1', duration: '4h' },
    response: () => jsonResponse(wardenLeaveView),
    expected: wardenLeaveView,
  },
  {
    name: 'cgroupConfig',
    invoke: client => client.cgroupConfig(),
    verb: 'GET',
    path: '/v1/cgroups/config',
    response: () => jsonResponse(cgroupConfigView),
    expected: cgroupConfigView,
  },
  {
    name: 'updateCgroupConfig',
    invoke: client => client.updateCgroupConfig({ enabled: true, fleet: { cpuPercent: 50 } }),
    verb: 'PATCH',
    path: '/v1/cgroups/config',
    body: { enabled: true, fleet: { cpuPercent: 50 } },
    response: () => jsonResponse(cgroupConfigView),
    expected: cgroupConfigView,
  },
  {
    name: 'daemonUpdate',
    invoke: client => client.daemonUpdate(),
    verb: 'GET',
    path: '/v1/daemon/update',
    response: () => jsonResponse(daemonUpdateView),
    expected: daemonUpdateView,
  },
  {
    name: 'startDaemonUpdate',
    invoke: client => client.startDaemonUpdate({ target: '4.29.0', when: 'when-idle' }),
    verb: 'POST',
    path: '/v1/daemon/update',
    body: { target: '4.29.0', when: 'when-idle' },
    response: () => jsonResponse(daemonUpdateView),
    expected: daemonUpdateView,
  },
  {
    name: 'updateDaemonUpdateSettings',
    invoke: client => client.updateDaemonUpdateSettings({ autoInstall: true }),
    verb: 'PATCH',
    path: '/v1/daemon/update/settings',
    body: { autoInstall: true },
    response: () => jsonResponse(daemonUpdateView),
    expected: daemonUpdateView,
  },
  {
    name: 'harnessUpdate',
    invoke: client => client.harnessUpdate(),
    verb: 'GET',
    path: '/v1/harnesses/update',
    response: () => jsonResponse(harnessUpdateView),
    expected: harnessUpdateView,
  },
  {
    name: 'startHarnessUpdate',
    invoke: client => client.startHarnessUpdate({ harness: 'codex', target: '0.145.0', confirmUnverified: true }),
    verb: 'POST',
    path: '/v1/harnesses/update',
    body: { harness: 'codex', target: '0.145.0', confirmUnverified: true },
    response: () => jsonResponse(harnessUpdateView),
    expected: harnessUpdateView,
  },
  {
    name: 'pwaConfig',
    invoke: client => client.pwaConfig(),
    verb: 'GET',
    path: '/v1/pwa/config',
    response: () => jsonResponse(pwaConfigView),
    expected: pwaConfigView,
  },
  {
    name: 'updatePwaConfig through the normalizing patch schema',
    invoke: client => client.updatePwaConfig({ name: '  Fleet   Controls ', icon: ' fy ' }),
    verb: 'PATCH',
    path: '/v1/pwa/config',
    body: { name: 'Fleet Controls', icon: 'FY' },
    response: () => jsonResponse(pwaConfigView),
    expected: pwaConfigView,
  },
  {
    name: 'usage',
    invoke: client => client.usage(),
    verb: 'GET',
    path: '/v1/usage',
    response: () => jsonResponse(usageFeedView),
    expected: usageFeedView,
  },
  {
    name: 'projects',
    invoke: client => client.projects(),
    verb: 'GET',
    path: '/v1/projects',
    response: () => jsonResponse([]),
    expected: [],
  },
  {
    name: 'sessionSkills with a percent-encoded session id',
    invoke: client => client.sessionSkills('session 1/a'),
    verb: 'GET',
    path: '/v1/sessions/session%201%2Fa/skills',
    response: () => jsonResponse({ harness: 'codex', skills: [] }),
    expected: { harness: 'codex', skills: [] },
  },
  {
    name: 'skillsInventory',
    invoke: client => client.skillsInventory(),
    verb: 'GET',
    path: '/v1/skills',
    response: () => jsonResponse({ homes: [], projects: [], truncated: false }),
    expected: { homes: [], projects: [], truncated: false },
  },
  {
    name: 'sessionSkillsInventory with a percent-encoded session id',
    invoke: client => client.sessionSkillsInventory('session 1/a'),
    verb: 'GET',
    path: '/v1/sessions/session%201%2Fa/skills/inventory',
    response: () => jsonResponse({ sessionId: 'session 1/a', harness: 'codex', skills: [], truncated: false }),
    expected: { sessionId: 'session 1/a', harness: 'codex', skills: [], truncated: false },
  },
  {
    name: 'skillFile without a session',
    invoke: client => client.skillFile('/h/skills/a b/SKILL.md'),
    verb: 'GET',
    path: '/v1/skills/file?path=%2Fh%2Fskills%2Fa+b%2FSKILL.md',
    response: () => jsonResponse({ path: '/h/skills/a b/SKILL.md', content: 'x' }),
    expected: { path: '/h/skills/a b/SKILL.md', content: 'x' },
  },
  {
    name: 'skillFile with a session',
    invoke: client => client.skillFile('/p/SKILL.md', 's 1'),
    verb: 'GET',
    path: '/v1/skills/file?path=%2Fp%2FSKILL.md&sessionId=s+1',
    response: () => jsonResponse({ path: '/p/SKILL.md', content: 'y' }),
    expected: { path: '/p/SKILL.md', content: 'y' },
  },
  {
    name: 'analytics without a query',
    invoke: client => client.analytics(),
    verb: 'GET',
    path: '/v1/analytics',
    response: () => jsonResponse(analyticsResponse),
    expected: analyticsResponse,
  },
  {
    name: 'analytics with a blank query',
    invoke: client => client.analytics('   '),
    verb: 'GET',
    path: '/v1/analytics',
    response: () => jsonResponse(analyticsResponse),
    expected: analyticsResponse,
  },
  {
    name: 'analytics with an encoded query',
    invoke: client => client.analytics('  status:running &live  '),
    verb: 'GET',
    path: '/v1/analytics?q=status%3Arunning+%26live',
    response: () => jsonResponse(analyticsResponse),
    expected: analyticsResponse,
  },
  {
    name: 'foreignHistory',
    invoke: client => client.foreignHistory(),
    verb: 'GET',
    path: '/v1/imports/history',
    response: () => jsonResponse(FOREIGN_HISTORY),
    expected: FOREIGN_HISTORY,
  },
  {
    name: 'foreignHistoryConversation with a percent-encoded id',
    invoke: client => client.foreignHistoryConversation('import 1/a'),
    verb: 'GET',
    path: '/v1/imports/history/import%201%2Fa',
    response: () => jsonResponse(FOREIGN_CONVERSATION),
    expected: FOREIGN_CONVERSATION,
  },
  {
    name: 'scratchPlan with the default limit',
    invoke: client => client.scratchPlan(),
    verb: 'GET',
    path: '/v1/gc?limit=20',
    response: () => jsonResponse([scratchPlanView]),
    expected: [scratchPlanView],
  },
  {
    name: 'scratchPlan with an explicit limit',
    invoke: client => client.scratchPlan(5),
    verb: 'GET',
    path: '/v1/gc?limit=5',
    response: () => jsonResponse([scratchPlanView]),
    expected: [scratchPlanView],
  },
  {
    name: 'scratchSweep without force',
    invoke: client => client.scratchSweep(),
    verb: 'POST',
    path: '/v1/gc',
    body: { force: false },
    response: () => jsonResponse(scratchSweepView),
    expected: scratchSweepView,
  },
  {
    name: 'scratchSweep with force',
    invoke: client => client.scratchSweep(true),
    verb: 'POST',
    path: '/v1/gc',
    body: { force: true },
    response: () => jsonResponse(scratchSweepView),
    expected: scratchSweepView,
  },
  {
    name: 'openUrl',
    invoke: client => client.openUrl('https://example.com/a?b=1'),
    verb: 'POST',
    path: '/v1/system/open-url',
    body: { url: 'https://example.com/a?b=1' },
    response: () => jsonResponse({ opened: true, host: 'example.com' }),
    expected: { opened: true, host: 'example.com' },
  },
  {
    name: 'list',
    invoke: client => client.list(),
    verb: 'GET',
    path: '/v1/sessions',
    response: () => jsonResponse([sessionView]),
    expected: [sessionView],
  },
  {
    name: 'suggestNames with the default count',
    invoke: client => client.suggestNames(),
    verb: 'GET',
    path: '/v1/names?count=1',
    response: () => jsonResponse(NAME_SUGGESTIONS.slice(0, 1)),
    expected: NAME_SUGGESTIONS.slice(0, 1),
  },
  {
    name: 'suggestNames with an explicit count',
    invoke: client => client.suggestNames(3),
    verb: 'GET',
    path: '/v1/names?count=3',
    response: () => jsonResponse(NAME_SUGGESTIONS),
    expected: NAME_SUGGESTIONS,
  },
  {
    name: 'get with a percent-encoded session id',
    invoke: client => client.get('session 1/a'),
    verb: 'GET',
    path: '/v1/sessions/session%201%2Fa',
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'send',
    invoke: client => client.send(SESSION_ID, { message: 'hello', now: true }),
    verb: 'POST',
    path: '/v1/sessions/session-1/send',
    body: { message: 'hello', now: true },
    response: () => jsonResponse(sendResult),
    expected: sendResult,
  },
  {
    name: 'send with a caller-supplied request id',
    invoke: client => client.send(SESSION_ID, { message: 'hello' }, 'send-logical-1'),
    verb: 'POST',
    path: '/v1/sessions/session-1/send',
    body: { message: 'hello' },
    requestId: 'send-logical-1',
    response: () => jsonResponse(sendResult),
    expected: sendResult,
  },
  {
    name: 'sends',
    invoke: client => client.sends(SESSION_ID),
    verb: 'GET',
    path: '/v1/sessions/session-1/sends',
    response: () => jsonResponse({ sends: [sendRecord] }),
    expected: [sendRecord],
  },
  {
    name: 'send status with an encoded send id',
    invoke: client => client.sendStatus(SESSION_ID, 'send 1/a'),
    verb: 'GET',
    path: '/v1/sessions/session-1/sends/send%201%2Fa',
    response: () => jsonResponse(sendRecord),
    expected: sendRecord,
  },
  {
    name: 'hand-off document behind a pointer',
    invoke: client => client.handoff(SESSION_ID, 'turn-008'),
    verb: 'GET',
    path: '/v1/sessions/session-1/handoffs/turn-008',
    response: () =>
      jsonResponse({ name: 'turn-008', message: 'hi', attachments: [{ filename: 'a.png', mime: 'image/png' }] }),
    expected: { name: 'turn-008', message: 'hi', attachments: [{ filename: 'a.png', mime: 'image/png' }] },
  },
  {
    name: 'transcript image behind a handle',
    invoke: client => client.transcriptImage(SESSION_ID, '120.340.1'),
    verb: 'GET',
    path: '/v1/sessions/session-1/transcript-images/120.340.1',
    response: () =>
      jsonResponse({
        image: { handle: '120.340.1', mediaType: 'image/png', byteLength: 12 },
        base64: 'iVBORw0KGgoAAAAA',
      }),
    expected: {
      image: { handle: '120.340.1', mediaType: 'image/png', byteLength: 12 },
      base64: 'iVBORw0KGgoAAAAA',
    },
  },
  {
    name: 'retry send',
    invoke: client => client.retrySend(SESSION_ID, 'send-1'),
    verb: 'POST',
    path: '/v1/sessions/session-1/sends/send-1/retry',
    body: {},
    response: () => jsonResponse(sendRecord),
    expected: sendRecord,
  },
  {
    name: 'retry send anyway',
    invoke: client => client.retrySend(SESSION_ID, 'send-1', true),
    verb: 'POST',
    path: '/v1/sessions/session-1/sends/send-1/retry',
    body: { force: true },
    response: () => jsonResponse(sendRecord),
    expected: sendRecord,
  },
  {
    name: 'cancel send',
    invoke: client => client.cancelSend(SESSION_ID, 'send-1'),
    verb: 'POST',
    path: '/v1/sessions/session-1/sends/send-1/cancel',
    body: {},
    response: () => jsonResponse(sendRecord),
    expected: sendRecord,
  },
  {
    name: 'press Enter for a send typed and not sent',
    invoke: client => client.submitSend(SESSION_ID, 'send-1'),
    verb: 'POST',
    path: '/v1/sessions/session-1/sends/send-1/enter',
    body: {},
    response: () => jsonResponse(sendRecord),
    expected: sendRecord,
  },
  {
    name: 'press Enter on the person’s own draft in the composer',
    invoke: client => client.resolveComposerDraft(SESSION_ID, { action: 'submit', draft: 'fix the login bug' }),
    verb: 'POST',
    path: '/v1/sessions/session-1/composer',
    body: { action: 'submit', draft: 'fix the login bug' },
    response: () => jsonResponse({ action: 'submit', outcome: 'submitted' }),
    expected: { action: 'submit', outcome: 'submitted' },
  },
  {
    name: 'answer with labels only',
    invoke: client => client.answer(SESSION_ID, 'tool-1', ['yes']),
    verb: 'POST',
    path: '/v1/sessions/session-1/answer',
    body: { toolUseId: 'tool-1', labels: ['yes'] },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'answer with free text, legacy responses, and lossless ordered answers',
    invoke: client =>
      client.answer(
        SESSION_ID,
        'tool-1',
        ['other'],
        'ship it',
        ['first', 'second'],
        [
          { kind: 'selection', labels: ['first', 'also first'] },
          { kind: 'other', text: 'second' },
        ],
        'question-request-1',
      ),
    verb: 'POST',
    path: '/v1/sessions/session-1/answer',
    body: {
      toolUseId: 'tool-1',
      labels: ['other'],
      other: 'ship it',
      responses: ['first', 'second'],
      answers: [
        { kind: 'selection', labels: ['first', 'also first'] },
        { kind: 'other', text: 'second' },
      ],
    },
    requestId: 'question-request-1',
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'interrupt',
    invoke: client => client.interrupt(SESSION_ID),
    verb: 'POST',
    path: '/v1/sessions/session-1/interrupt',
    body: {},
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'stop without a reason',
    invoke: client => client.stop(SESSION_ID),
    verb: 'POST',
    path: '/v1/sessions/session-1/stop',
    body: {},
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'stop with a reason',
    invoke: client => client.stop(SESSION_ID, 'operator asked'),
    verb: 'POST',
    path: '/v1/sessions/session-1/stop',
    body: { reason: 'operator asked' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'resume without a message',
    invoke: client => client.resume(SESSION_ID),
    verb: 'POST',
    path: '/v1/sessions/session-1/resume',
    body: {},
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'resume with a message',
    invoke: client => client.resume(SESSION_ID, 'carry on'),
    verb: 'POST',
    path: '/v1/sessions/session-1/resume',
    body: { message: 'carry on' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'runtime model and effort',
    invoke: client =>
      client.runtime(SESSION_ID, { action: 'model', model: 'gpt-5.6-sol', effort: 'high' }, 'runtime-1'),
    verb: 'POST',
    path: '/v1/sessions/session-1/runtime',
    body: { action: 'model', model: 'gpt-5.6-sol', effort: 'high' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'runtime opens Codex native picker without claiming a selected model',
    invoke: client => client.runtime(SESSION_ID, { action: 'model' }),
    verb: 'POST',
    path: '/v1/sessions/session-1/runtime',
    body: { action: 'model' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'migrate with the agent alone',
    invoke: client => client.migrate(SESSION_ID, 'claude-auto-loge'),
    verb: 'POST',
    path: '/v1/sessions/session-1/migrate',
    body: { agent: 'claude-auto-loge', allowContextDowngrade: false, forceInflight: false },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'migrate with a model and an accepted context downgrade',
    invoke: client => client.migrate(SESSION_ID, 'claude-auto-loge', 'claude-opus-5', true),
    verb: 'POST',
    path: '/v1/sessions/session-1/migrate',
    body: {
      agent: 'claude-auto-loge',
      model: 'claude-opus-5',
      allowContextDowngrade: true,
      forceInflight: false,
    },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'migrate past the in-flight check after an explicit Restart anyway',
    invoke: client => client.migrate(SESSION_ID, 'claude-auto-loge', undefined, false, 'req-anyway', true),
    verb: 'POST',
    path: '/v1/sessions/session-1/migrate',
    body: { agent: 'claude-auto-loge', allowContextDowngrade: false, forceInflight: true },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'migrate onto the earlier conversation only when it is asked for',
    invoke: client =>
      client.migrate(SESSION_ID, 'claude-auto-loge', undefined, false, 'req-earlier', false, 'previous'),
    verb: 'POST',
    path: '/v1/sessions/session-1/migrate',
    body: { agent: 'claude-auto-loge', allowContextDowngrade: false, forceInflight: false, conversation: 'previous' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'migrate converting onto the other harness',
    invoke: client => client.migrate(SESSION_ID, 'codex-a', undefined, false, 'req-convert', false, 'convert'),
    verb: 'POST',
    path: '/v1/sessions/session-1/migrate',
    body: { agent: 'codex-a', allowContextDowngrade: false, forceInflight: false, conversation: 'convert' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'a restart of the outdated ferrets with its own request id',
    invoke: client => client.restart({ scope: 'outdated' }, 'req-restart'),
    verb: 'POST',
    path: '/v1/restarts',
    body: { scope: 'outdated' },
    requestId: 'req-restart',
    response: () => Response.json({ restarted: [], queued: [], skipped: [], failed: [] }),
    expected: { restarted: [], queued: [], skipped: [], failed: [] },
  },
  {
    name: 'what is outdated and what waits',
    invoke: client => client.restartStatus(),
    verb: 'GET',
    path: '/v1/restarts',
    response: () => Response.json({ outdated: [], queued: [] }),
    expected: { outdated: [], queued: [] },
  },
  {
    name: 'clearing the waiting restarts',
    invoke: client => client.cancelRestarts(),
    verb: 'DELETE',
    path: '/v1/restarts',
    response: () => Response.json({ cancelled: 2 }),
    expected: { cancelled: 2 },
  },
  {
    name: 'conversion preview for an account',
    invoke: client => client.conversionPreview(SESSION_ID, 'codex-a'),
    verb: 'POST',
    path: '/v1/sessions/session-1/conversion-preview',
    body: { agent: 'codex-a' },
    response: () => Response.json({ kind: 'refused', targetAgent: 'codex-a', reason: 'Too new.' }),
    expected: { kind: 'refused', targetAgent: 'codex-a', reason: 'Too new.' },
  },
  {
    name: 'conversion preview for an account and a model',
    invoke: client => client.conversionPreview(SESSION_ID, 'codex-a', 'gpt-5.5'),
    verb: 'POST',
    path: '/v1/sessions/session-1/conversion-preview',
    body: { agent: 'codex-a', model: 'gpt-5.5' },
    response: () => Response.json({ kind: 'refused', targetAgent: 'codex-a', reason: 'Too new.' }),
    expected: { kind: 'refused', targetAgent: 'codex-a', reason: 'Too new.' },
  },
  {
    name: 'rename with a name',
    invoke: client => client.rename(SESSION_ID, 'Cover Typed Methods'),
    verb: 'POST',
    path: '/v1/sessions/session-1/rename',
    body: { name: 'Cover Typed Methods' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'rename with a teammate and a cleared parent',
    invoke: client => client.rename(SESSION_ID, undefined, 'reviewer', true),
    verb: 'POST',
    path: '/v1/sessions/session-1/rename',
    body: { teammate: 'reviewer', clearParent: true },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'signal done',
    invoke: client => client.signal(SESSION_ID, 'done'),
    verb: 'POST',
    path: '/v1/sessions/session-1/signal',
    body: { kind: 'done' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'signal help with the required message',
    invoke: client => client.signal(SESSION_ID, 'help', 'blocked on credentials'),
    verb: 'POST',
    path: '/v1/sessions/session-1/signal',
    body: { kind: 'help', message: 'blocked on credentials' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'signal waiting with every wait option',
    invoke: client =>
      client.signal(SESSION_ID, 'waiting', 'parked', { until: '45m', condition: 'ci run', peer: 'session-2' }),
    verb: 'POST',
    path: '/v1/sessions/session-1/signal',
    body: { kind: 'waiting', message: 'parked', until: '45m', condition: 'ci run', peer: 'session-2' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'signal working',
    invoke: client => client.signal(SESSION_ID, 'working'),
    verb: 'POST',
    path: '/v1/sessions/session-1/signal',
    body: { kind: 'working' },
    response: sessionResponse,
    expected: sessionView,
  },
  {
    name: 'remove with default flags',
    invoke: client => client.remove(SESSION_ID),
    verb: 'DELETE',
    path: '/v1/sessions/session-1?purge=false&force=false',
    response: () => emptyResponse(),
    expected: undefined,
  },
  {
    name: 'remove with purge and force',
    invoke: client => client.remove(SESSION_ID, true, true),
    verb: 'DELETE',
    path: '/v1/sessions/session-1?purge=true&force=true',
    response: () => emptyResponse(),
    expected: undefined,
  },
  {
    name: 'attachTarget',
    invoke: client => client.attachTarget(SESSION_ID),
    verb: 'GET',
    path: '/v1/sessions/session-1/attach',
    response: () => jsonResponse(sessionAttachTarget),
    expected: sessionAttachTarget,
  },
  {
    name: 'snapshot',
    invoke: client => client.snapshot(SESSION_ID),
    verb: 'GET',
    path: '/v1/sessions/session-1/snapshot?live=true',
    response: () => textResponse(SNAPSHOT_TEXT),
    expected: SNAPSHOT_TEXT,
  },
  {
    name: 'snapshot of the whole history',
    invoke: client => client.snapshot(SESSION_ID, 'history'),
    verb: 'GET',
    path: '/v1/sessions/session-1/snapshot?live=true',
    response: () => textResponse(SNAPSHOT_TEXT),
    expected: SNAPSHOT_TEXT,
  },
  {
    name: 'snapshot of the visible screen',
    invoke: client => client.snapshot(SESSION_ID, 'screen'),
    verb: 'GET',
    path: '/v1/sessions/session-1/snapshot?live=true&scope=screen',
    response: () => textResponse(SNAPSHOT_TEXT),
    expected: SNAPSHOT_TEXT,
  },
  {
    name: 'logs without a turn',
    invoke: client => client.logs(SESSION_ID),
    verb: 'GET',
    path: '/v1/sessions/session-1/logs',
    response: () => textResponse(LOG_TEXT),
    expected: LOG_TEXT,
  },
  {
    name: 'logs for turn zero',
    invoke: client => client.logs(SESSION_ID, 0),
    verb: 'GET',
    path: '/v1/sessions/session-1/logs?turn=0',
    response: () => textResponse(LOG_TEXT),
    expected: LOG_TEXT,
  },
  {
    // No cursor and no limit means NO query string at all. `?cursor=&limit=` would be two malformed
    // values rather than two unstated ones, and the daemon owns the default page size.
    name: 'messages from the first forkable row',
    invoke: client => client.messages(SESSION_ID),
    verb: 'GET',
    path: '/v1/sessions/session-1/messages',
    response: () => jsonResponse(TRANSCRIPT_PAGE),
    expected: TRANSCRIPT_PAGE,
  },
  {
    name: 'messages continuing after an opaque cursor',
    invoke: client => client.messages(SESSION_ID, 'message-cursor-1'),
    verb: 'GET',
    path: '/v1/sessions/session-1/messages?cursor=message-cursor-1',
    response: () => jsonResponse(TRANSCRIPT_PAGE),
    expected: TRANSCRIPT_PAGE,
  },
  {
    name: 'messages with a stated page size and no cursor',
    invoke: client => client.messages(SESSION_ID, undefined, 50),
    verb: 'GET',
    path: '/v1/sessions/session-1/messages?limit=50',
    response: () => jsonResponse(TRANSCRIPT_PAGE),
    expected: TRANSCRIPT_PAGE,
  },
  {
    name: 'messages with both a cursor and the server maximum',
    invoke: client => client.messages('sessions/../secrets', 'message-cursor-1', 1_000),
    verb: 'GET',
    path: '/v1/sessions/sessions%2F..%2Fsecrets/messages?cursor=message-cursor-1&limit=1000',
    response: () => jsonResponse(TRANSCRIPT_PAGE),
    expected: TRANSCRIPT_PAGE,
  },
  {
    name: 'events with default paging',
    invoke: client => client.events(SESSION_ID),
    verb: 'GET',
    path: '/v1/sessions/session-1/events?after=0&limit=1000',
    response: () => jsonResponse([fyEvent]),
    expected: [fyEvent],
  },
  {
    name: 'events with an explicit cursor and limit',
    invoke: client => client.events(SESSION_ID, 5, 10),
    verb: 'GET',
    path: '/v1/sessions/session-1/events?after=5&limit=10',
    response: () => jsonResponse([fyEvent]),
    expected: [fyEvent],
  },
];

describe('FyApiClient typed method delegation', () => {
  for (const testCase of CASES) {
    it(`should route ${testCase.name} to ${testCase.verb} ${testCase.path}`, async () => {
      // Arrange
      const transport = new QueuedHttpTransport(testCase.response());
      const client = await connectClient(transport);

      // Act
      const actual = await testCase.invoke(client);

      // Assert
      should(actual).deepEqual(testCase.expected);
      should(transport.calls).have.length(1);
      should(transport.calls[0]?.url).equal(`${BASE_URL}${testCase.path}`);
      should(transport.calls[0]?.init.method ?? 'GET').equal(testCase.verb);
      if (testCase.body === undefined) {
        should(transport.calls[0]?.init.body).be.undefined();
      } else {
        should(jsonBodyOf(transport)).deepEqual(testCase.body);
        should(headersOf(transport).get('content-type')).equal('application/json');
      }
      if (testCase.requestId !== undefined)
        should(headersOf(transport).get(FY_REQUEST_ID_HEADER)).equal(testCase.requestId);
    });
  }

  for (const testCase of CASES) {
    it(`should reject a ${testCase.name} payload the response schema does not accept`, async () => {
      // Arrange
      const transport = new QueuedHttpTransport(jsonResponse({ unexpected: 'payload' }));
      const client = await connectClient(transport);

      // Act
      const actual = await captureError(() => testCase.invoke(client));

      // Assert
      should(actual instanceof z.ZodError).be.true();
      should(transport.calls).have.length(1);
    });
  }

  it('should put the cursor on the wire exactly as the daemon issued it', async () => {
    // The cursor is daemon-issued, daemon-verified evidence about the prefix already served. A
    // client that trimmed it, re-encoded it, or rebuilt it from the last row's point would present
    // a token nobody issued — and the refusal that followed would read as a changed transcript.
    // Arrange — the characters a careless client damages: padding, a plus, a slash, a tab.
    const opaqueCursor = ' cur/v1+AAAA==\tBBBB ';
    const transport = new QueuedHttpTransport(jsonResponse(TRANSCRIPT_PAGE));
    const client = await connectClient(transport);

    // Act
    await client.messages(SESSION_ID, opaqueCursor);

    // Assert — decoded from the query rather than compared against a hand-spelled escaping, so the
    // assertion proves fidelity rather than restating one encoder's output.
    const url = new URL(String(transport.calls[0]?.url));
    should(url.pathname).equal('/api/v1/sessions/session-1/messages');
    should(url.searchParams.get('cursor')).equal(opaqueCursor);
    should(url.searchParams.has('limit')).be.false();
  });

  it('should let a caller cancel a long message read', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(jsonResponse(TRANSCRIPT_PAGE));
    const client = await connectClient(transport);
    const controller = new AbortController();

    // Act
    const actual = await client.messages(SESSION_ID, undefined, undefined, controller.signal);

    // Assert
    should(actual).deepEqual(TRANSCRIPT_PAGE);
    should(transport.calls[0]?.init.signal).not.be.undefined();
  });

  it('should pass a caller cancellation through an event read', async () => {
    // Arrange
    const cancelled = new Error('operator left');
    const transport = new QueuedHttpTransport(
      call =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal;
          if (signal === undefined || signal === null) throw new Error('event request had no signal');
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const client = await connectClient(transport);
    const controller = new AbortController();

    // Act
    const reading = client.events(SESSION_ID, 0, 1_000, controller.signal);
    controller.abort(cancelled);
    const failure = await captureError(() => reading);

    // Assert — request() classifies a caller abort and does not retry it.
    should(failure).be.instanceof(FyTransportError);
    should((failure as FyTransportError).message).match(/was cancelled/);
    should(transport.calls).have.length(1);
    should(transport.calls[0]?.init.signal?.aborted).be.true();
  });

  it('should make a wait-style session read cancellable too', async () => {
    // Arrange
    const transport = new QueuedHttpTransport(sessionResponse());
    const client = await connectClient(transport);
    const controller = new AbortController();

    // Act
    const actual = await client.get(SESSION_ID, controller.signal);

    // Assert
    should(actual).deepEqual(sessionView);
    should(transport.calls[0]?.init.signal).not.be.undefined();
  });
});

describe('FyApiClient typed method input validation', () => {
  it('should reject invalid session identifiers before any transport I/O', async () => {
    // Arrange
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);
    const invocations: Array<() => Promise<unknown>> = [
      () => client.get('   '),
      () => client.send('', { message: 'hello' }),
      () => client.remove('   '),
      () => client.attachTarget('   '),
      () => client.snapshot('   '),
      () => client.logs('   '),
      () => client.events('   '),
      () => client.messages('   '),
      () => client.upload('   ', new Blob(['a'])),
    ];

    // Act
    const actual = await Promise.all(invocations.map(invocation => captureError(invocation)));

    // Assert
    for (const error of actual) should(error instanceof z.ZodError).be.true();
    should(transport.calls).have.length(0);
  });

  it('should reject out-of-range paging and counting arguments before any transport I/O', async () => {
    // Arrange
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);
    const invocations: Array<() => Promise<unknown>> = [
      () => client.scratchPlan(0),
      () => client.suggestNames(0),
      () => client.logs('session-1', -1),
      () => client.events('session-1', -1),
      () => client.events('session-1', 0, 1_001),
      () => client.history('session-1', 0, 0),
      // The daemon enforces 1..1,000 itself; refusing the same range here costs a round trip that
      // could only ever end in `invalid_query`.
      () => client.messages('session-1', undefined, 0),
      () => client.messages('session-1', undefined, 1_001),
      () => client.messages('session-1', undefined, 1.5),
      // A blank cursor is not "no cursor". Sending it would ask the daemon to authenticate an empty
      // token rather than start from the first row.
      () => client.messages('session-1', '   '),
    ];

    // Act
    const actual = await Promise.all(invocations.map(invocation => captureError(invocation)));

    // Assert
    for (const error of actual) should(error instanceof z.ZodError).be.true();
    should(transport.calls).have.length(0);
  });

  it('should reject request bodies their schemas refuse before any transport I/O', async () => {
    // Arrange
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport);
    const invocations: Array<() => Promise<unknown>> = [
      () => client.send('session-1', { message: '' }),
      () => client.answer('session-1', '', ['yes']),
      () => client.rename('session-1'),
      () => client.updatePwaConfig({}),
      () => client.updatePwaConfig({ icon: 'too-long' }),
      () => client.signal('session-1', 'help'),
      () => client.signal('session-1', 'done', 'finished', { until: '45m' }),
    ];

    // Act
    const actual = await Promise.all(invocations.map(invocation => captureError(invocation)));

    // Assert
    for (const error of actual) should(error instanceof z.ZodError).be.true();
    should(transport.calls).have.length(0);
  });
});

describe('FyApiClient send retry identity', () => {
  const failure = (): { throws: unknown } => ({ throws: new Error('connection reset') });
  const idsOf = (transport: QueuedHttpTransport): (string | null)[] =>
    transport.calls.map(call => new Headers(call.init.headers).get(FY_REQUEST_ID_HEADER));

  it('should reuse a failed send id for the same message and mint a new one once it succeeds', async () => {
    // Arrange — every transport failure is retried three times inside request(), so a failed send
    // consumes three outcomes.
    let minted = 0;
    const transport = new QueuedHttpTransport(
      failure(),
      failure(),
      failure(),
      jsonResponse(sendResult),
      jsonResponse(sendResult),
    );
    const client = await connectClient(transport, { requestId: () => `minted-${++minted}` });

    // Act
    await captureError(() => client.send(SESSION_ID, { message: 'hello', attachmentIds: ['b', 'a'] }));
    await client.send(SESSION_ID, { message: 'hello', attachmentIds: ['a', 'b'], now: true });
    await client.send(SESSION_ID, { message: 'hello', attachmentIds: ['a', 'b'] });

    // Assert — the press after the error is the SAME logical send; the one after a success is not.
    should(idsOf(transport)).deepEqual(['minted-1', 'minted-1', 'minted-1', 'minted-1', 'minted-2']);
  });

  it('should forget a failed id after ten minutes and keep at most thirty-two', async () => {
    // Arrange
    let now = 0;
    let minted = 0;
    const transport = new QueuedHttpTransport();
    const client = await connectClient(transport, { requestId: () => `minted-${++minted}`, nowMs: () => now });
    const fail = async (message: string): Promise<void> => {
      transport.enqueue(failure(), failure(), failure());
      await captureError(() => client.send(SESSION_ID, { message }));
    };
    const succeed = async (message: string): Promise<string | null> => {
      transport.enqueue(jsonResponse(sendResult));
      await client.send(SESSION_ID, { message });
      return idsOf(transport).at(-1) ?? null;
    };

    // Act
    await fail('stale');
    now = 10 * 60_000 + 1;
    const afterExpiry = await succeed('stale');
    for (let index = 0; index < 33; index++) await fail(`message-${index}`);
    const evicted = await succeed('message-0');
    const kept = await succeed('message-32');

    // Assert
    should(afterExpiry).equal('minted-2');
    should(evicted).not.equal('minted-3');
    should(kept).equal('minted-35');
  });
});
