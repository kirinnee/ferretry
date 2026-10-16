/**
 * The harness daemon's configuration files: one invalid file (its last good version in effect), one
 * loosening edit waiting for the owner, and a login that names its key by `${secret:NAME}` — the three
 * states the Files panel exists to show, on screen together.
 *
 * Answered from memory per client, so every capture starts from these files rather than from whatever
 * an earlier capture saved. Saving `warden.yaml` is refused with its located issues, which is how the
 * editor's inline-issue frame is reached by pressing Save rather than by being posed.
 */

import {
  type ConfigFileView,
  type ConfigIssue,
  type ConfigPending,
  type ConfigStatusView,
  classifyConfigPath,
  configSchemaId,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { z } from 'zod';
import type { ConfigFilesClient } from '../src/features/config-files/config-files-api.ts';
import type { DaemonConnection } from '../src/lib/daemon-connection.ts';

const DIRECTORY = '/Users/ernest/.ferretry/config';

const FILES: Readonly<Record<string, string>> = {
  'machine.yaml': [
    '# yaml-language-server: $schema=.schema/machine.json',
    'agentPermissions: auto',
    'defaultRuntime: claude-default',
    'agentControl:',
    '  terminals: true',
    '  browsers: true',
    '  files: true',
    '  ferretrySettings: true',
    '',
  ].join('\n'),
  'logins/glm.yaml': [
    '# yaml-language-server: $schema=../.schema/login.json',
    'harness: claude',
    'label: GLM',
    'source:',
    '  kind: environment',
    '  env:',
    '    ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference, exactly as a file holds one
    '    ANTHROPIC_AUTH_TOKEN: ${secret:GLM_API_KEY}',
    '',
  ].join('\n'),
  'logins/claude.yaml': [
    '# yaml-language-server: $schema=../.schema/login.json',
    'harness: claude',
    'source:',
    '  kind: host',
    '',
  ].join('\n'),
  'profiles/default.yaml': [
    '# yaml-language-server: $schema=../.schema/profile.json',
    'contents:',
    '  - instructions/house-style',
    '  - mcp/github',
    '',
  ].join('\n'),
  'profiles/Agent work.yaml': [
    '# yaml-language-server: $schema=../.schema/profile.json',
    '# Later items override earlier ones on the same key.',
    'contents:',
    '  - profile/Default',
    '  - profile/Agent',
    '',
  ].join('\n'),
  'runtimes/claude-default.yaml': [
    '# yaml-language-server: $schema=../.schema/runtime.json',
    'login: claude',
    'profile: default',
    '',
  ].join('\n'),
  'components/mcp/github.yaml': [
    '# yaml-language-server: $schema=../../.schema/component-mcp.json',
    'type: http',
    'url: https://api.githubcopilot.com/mcp/',
    '',
  ].join('\n'),
  'warden.yaml': [
    '# yaml-language-server: $schema=.schema/warden.json',
    'enabled: true',
    'intervalMinutes: five',
    'accounts:',
    '  - agent: claude-auto-glm52a',
    'spendCap: 20',
    '',
  ].join('\n'),
  'learning.yaml': ['# yaml-language-server: $schema=.schema/learning.json', 'intervalMinutes: 60', ''].join('\n'),
};

const WARDEN_ISSUES: readonly ConfigIssue[] = [
  {
    path: 'warden.yaml',
    line: 3,
    column: 18,
    severity: 'error',
    message: 'intervalMinutes must be a whole number of minutes, not "five"',
    fix: 'Write a number, such as intervalMinutes: 5.',
  },
  {
    path: 'warden.yaml',
    line: 6,
    column: 1,
    severity: 'error',
    message: 'unknown setting "spendCap"',
    fix: 'Remove it — Warden settings are listed in docs/config-files.md.',
  },
];

const LEARNING_WARNING: ConfigIssue = {
  path: 'learning.yaml',
  severity: 'warning',
  message: 'learning.yaml sets nothing the defaults do not already',
  fix: 'Remove the file, or change a setting in it.',
};

const MACHINE_PENDING: ConfigPending = {
  path: 'machine.yaml',
  etag: 'sha256:harness-machine-2',
  changes: ['agents may now edit Ferretry settings'],
};

const stateOf = (path: string, pending: readonly ConfigPending[]): ConfigFileView['state'] => {
  if (path === 'warden.yaml') return 'invalid';
  return pending.some(held => held.path === path) ? 'pending' : 'ok';
};

const fileOf = (path: string, pending: readonly ConfigPending[]): ConfigFileView => {
  const address = classifyConfigPath(path);
  if (address === undefined) throw new FyHttpError(`${path} is not a configuration file`, 400, 'bad_request');
  return {
    path,
    absolutePath: `${DIRECTORY}/${path}`,
    kind: address.kind,
    schema: configSchemaId(address),
    exists: true,
    text: FILES[path] ?? '',
    etag: `sha256:harness-${path}`,
    state: stateOf(path, pending),
    issues: path === 'warden.yaml' ? [...WARDEN_ISSUES] : [],
  };
};

/** The harness daemon's Files panel client; the unreachable daemon fails like a real offline one. */
export const harnessConfigFilesClient =
  (offline: DaemonConnection['daemonId']) =>
  async (connection: DaemonConnection): Promise<ConfigFilesClient> => {
    if (connection.daemonId === offline) throw new Error('offline harness daemon');
    let pending: readonly ConfigPending[] = [MACHINE_PENDING];
    const status = (): ConfigStatusView => ({
      directory: DIRECTORY,
      files: Object.keys(FILES).map(path => {
        const view = fileOf(path, pending);
        return { path, kind: view.kind, schema: view.schema, state: view.state };
      }),
      issues: [...WARDEN_ISSUES, LEARNING_WARNING],
      pending: [...pending],
      checkedAt: new Date().toISOString(),
    });
    const answer = (path: string, init?: RequestInit): unknown => {
      const url = new URL(path, 'http://harness.invalid');
      if (url.pathname === '/v1/config/status') return status();
      if (url.pathname === '/v1/config/file' && (init?.method ?? 'GET') === 'GET')
        return fileOf(url.searchParams.get('path') ?? '', pending);
      const body = JSON.parse(String(init?.body)) as { readonly path: string; readonly etag?: string };
      if (url.pathname === '/v1/config/confirm') {
        pending = pending.filter(held => held.path !== body.path);
        return { path: body.path, confirmed: true };
      }
      if (body.path === 'warden.yaml') {
        const error = 'the file does not check (2 problems); nothing was written';
        throw new FyHttpError(error, 422, 'config_invalid', {
          error,
          code: 'config_invalid',
          issues: WARDEN_ISSUES,
        });
      }
      return { path: body.path, etag: `sha256:harness-${body.path}-saved`, outcome: 'applied' };
    };
    return {
      request: (async (path: string, schema: z.ZodType<unknown>, init?: RequestInit) =>
        schema.parse(answer(path, init))) as ConfigFilesClient['request'],
    };
  };
