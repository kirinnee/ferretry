import type { AuditedRouteRule } from '../../audit/routes.ts';
import type { ModuleContribution } from '../modules.ts';
import { type ConversationImportSubsystem, conversationImportRoutes } from './conversation-import.ts';
import { type ForeignHistorySubsystem, foreignHistoryRoutes } from './foreign-history.ts';

/**
 * The security log's rule for the one import act that writes. Keeping existing conversations as ferrets
 * (`./conversation-import.ts`) creates sessions that can launch agents, so it is recorded as fleet configuration. The
 * record names no conversation and no folder. The listing, the preview and both history reads write nothing, so they
 * have no rule.
 */
const IMPORTS_AUDIT_RULES: readonly AuditedRouteRule[] = [
  {
    method: 'POST',
    path: '/v1/imports/conversations/adopt',
    event: 'fleet.configured',
    detail: { action: 'adopt-conversations' },
  },
];

/** The two subsystems the conversation-import module serves. */
export interface ImportsSubsystems {
  readonly foreignHistory: ForeignHistorySubsystem;
  readonly conversationImport: ConversationImportSubsystem;
}

/**
 * What the conversation-import module adds to the daemon: the read-only foreign history under `/v1/imports/history`,
 * the conversation import under `/v1/imports/conversations`, and the adoption's audit rule. It claims no protocol
 * feature.
 *
 * Imported harness history is intentionally outside `/v1/sessions`: no foreign transcript has the journal/pane
 * evidence a managed session requires, so it cannot acquire live controls by looking like one. The two subsystems
 * share the `/v1/imports` prefix but their second segments (`history`, `conversations`) are different literals, so
 * neither can shadow the other.
 */
export function importsContribution(subsystems: ImportsSubsystems): ModuleContribution {
  return {
    routes: [
      ...foreignHistoryRoutes(subsystems.foreignHistory),
      ...conversationImportRoutes(subsystems.conversationImport),
    ],
    audit: { routes: IMPORTS_AUDIT_RULES },
  };
}
