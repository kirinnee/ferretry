import { z } from 'zod';
import { type ApiRequest, type ApiResponse, BodyTooLargeError } from '@ferretry/kernel/contract';
import type { ConnectorAuthority, ExchangeInput } from '../oauth/authority.ts';
import { authorizationServerMetadata, protectedResourceMetadata } from '../oauth/discovery.ts';
import { INVALID_CLIENT_TEXT, OAuthError, RECONNECT_HINT } from '../oauth/model.ts';
import type { ConnectorEndpoints, ConnectorHttpHandler } from '../ports.ts';
import { appPanelUrl, escapeHtml, failurePage, page } from './pages.ts';

const registration = z.object({
  client_name: z.string().max(100).optional(),
  redirect_uris: z.array(z.string().max(2048)).min(1).max(5),
  grant_types: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .min(1)
    .max(2)
    .optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']).optional(),
});
const boundedString = z.string().max(4096);
const authorize = z.object({
  response_type: boundedString,
  client_id: boundedString,
  redirect_uri: boundedString,
  code_challenge: boundedString.optional(),
  code_challenge_method: boundedString.optional(),
  state: boundedString.optional(),
  scope: boundedString.optional(),
  resource: boundedString.optional(),
});
const exchange = z.object({
  grant_type: boundedString,
  client_id: boundedString,
  client_secret: boundedString.optional(),
  code: boundedString.optional(),
  redirect_uri: boundedString.optional(),
  code_verifier: boundedString.optional(),
  refresh_token: boundedString.optional(),
  scope: boundedString.optional(),
  resource: boundedString.optional(),
});
const revocation = z.object({
  client_id: boundedString,
  client_secret: boundedString.optional(),
  token: boundedString,
});
function json(status: number, value: unknown, extra: readonly [string, string][] = []): ApiResponse {
  return {
    status,
    headers: new Map([['content-type', 'application/json'], ['cache-control', 'no-store'], ...extra]),
    body: JSON.stringify(value),
  };
}
function redirect(location: string): ApiResponse {
  return {
    status: 302,
    headers: new Map([
      ['location', location],
      ['cache-control', 'no-store'],
      ['referrer-policy', 'no-referrer'],
    ]),
    body: '',
  };
}
function oneValues(entries: Iterable<readonly [string, readonly string[]]>): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, values] of entries) {
    if (values.length !== 1) throw new OAuthError('invalid_request', 'Repeated parameters are not supported.');
    const value = values[0];
    if (value !== undefined) result[key] = value;
  }
  return result;
}
function formValues(text: string): Record<string, string> {
  const params = new URLSearchParams(text);
  return oneValues([...new Set(params.keys())].map(key => [key, params.getAll(key)] as const));
}
function credentials(
  request: ApiRequest,
  body: Record<string, string>,
): { readonly body: Record<string, string>; readonly authMethod?: ExchangeInput['authMethod'] } {
  const authorization = request.headers.get('authorization');
  if (!authorization) return { body, authMethod: body.client_secret === undefined ? 'none' : 'client_secret_post' };
  if (!/^Basic /i.test(authorization) || body.client_secret !== undefined)
    throw new OAuthError('invalid_client', `Use exactly one client authentication method. ${RECONNECT_HINT}`, 401);
  try {
    const decoded = atob(authorization.slice(6).trim());
    const colon = decoded.indexOf(':');
    if (colon < 0) throw new Error('Missing separator');
    const clientId = decodeURIComponent(decoded.slice(0, colon).replaceAll('+', ' '));
    const secret = decodeURIComponent(decoded.slice(colon + 1).replaceAll('+', ' '));
    if (body.client_id !== undefined && body.client_id !== clientId) throw new Error('Mismatched client');
    return { body: { ...body, client_id: clientId, client_secret: secret }, authMethod: 'client_secret_basic' };
  } catch {
    throw new OAuthError('invalid_client', INVALID_CLIENT_TEXT, 401);
  }
}

/** The public listener's OAuth boundary, intentionally unaware of the daemon's owner credentials. */
export class ConnectorOAuthHttp implements ConnectorHttpHandler {
  constructor(
    private readonly authority: ConnectorAuthority,
    private readonly endpoints: ConnectorEndpoints,
  ) {}

  async handle(request: ApiRequest): Promise<ApiResponse | undefined> {
    const get = request.method === 'GET';
    const post = request.method === 'POST';
    const path = request.path;
    if (
      get &&
      (path === '/.well-known/oauth-protected-resource/mcp' || path === '/.well-known/oauth-protected-resource')
    )
      return json(200, protectedResourceMetadata(this.endpoints));
    if (get && path === '/.well-known/oauth-authorization-server')
      return json(200, authorizationServerMetadata(this.endpoints));
    const html = get && (path === '/oauth/authorize' || path === '/oauth/authorize/wait');
    if (!html && !(post && ['/oauth/register', '/oauth/token', '/oauth/revoke'].includes(path))) return undefined;
    // One bucket per arriving address (the listener sets it from CF-Connecting-IP); absent is a shared bucket.
    const arrival = { source: request.clientAddress ?? 'unknown', admitted: true };
    try {
      if (path === '/oauth/register') this.authority.admit('register', arrival.source);
      if (path === '/oauth/authorize') this.authority.admit('authorize', arrival.source);
      if (path === '/oauth/authorize/wait') this.authority.admit('wait', arrival.source);
      if (path === '/oauth/token' || path === '/oauth/revoke') this.authority.admit('token', arrival.source);
      if (get && path === '/oauth/authorize') {
        const parsed = authorize.safeParse(oneValues(request.query));
        if (!parsed.success) throw new OAuthError('invalid_request', 'Missing or invalid authorization parameters.');
        return redirect(await this.authority.startAuthorization(parsed.data, arrival));
      }
      if (get && path === '/oauth/authorize/wait') {
        const query = oneValues(request.query);
        if (!query.h || !/^[A-Za-z0-9_-]{43}$/.test(query.h))
          throw new OAuthError(
            'invalid_request',
            'This sign-in is unknown or expired.',
            400,
            undefined,
            undefined,
            'sign_in_gone',
          );
        const result = await this.authority.waitPage(query.h, arrival);
        if (result.kind === 'redirect') return redirect(result.location);
        const pending = result.pending;
        const scopes = pending.scopes.map(scope =>
          scope === 'fleet:read'
            ? 'Read your ferrets and attention inbox'
            : 'Send messages, answer attention, and start, stop or restart ferrets',
        );
        return page(
          'Approve this connection in Ferretry',
          `<p>${escapeHtml(pending.clientName)} wants to connect.</p><p>${escapeHtml(scopes.join('. '))}</p><p>Match this code in Ferretry:</p><strong class="code">${escapeHtml(pending.matchCode)}</strong><p><a class="button" href="${escapeHtml(appPanelUrl(this.endpoints))}">Open Ferretry</a></p><p>Waiting for your decision. This page refreshes by itself, so you can leave it open.</p><h2>If nothing happens</h2><p>This sign-in expires after 10 minutes. To start again, in Claude open Settings &gt; Connectors &gt; Ferretry &gt; Connect.</p>`,
          { refresh: true },
        );
      }
      const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (
        contentType !== 'application/x-www-form-urlencoded' &&
        !(path === '/oauth/register' && contentType === 'application/json')
      )
        throw new OAuthError(
          'invalid_request',
          'Use application/x-www-form-urlencoded (or JSON for registration).',
          415,
        );
      const text = await request.text(8192);
      if (new TextEncoder().encode(text).byteLength > 8192)
        throw new OAuthError('invalid_request', 'Request body exceeds 8 KiB.', 413);
      if (path === '/oauth/register') {
        let value: unknown;
        try {
          if (contentType === 'application/json') value = JSON.parse(text);
          else {
            const form = formValues(text);
            value = {
              ...form,
              redirect_uris: form.redirect_uris ? JSON.parse(form.redirect_uris) : undefined,
              grant_types: form.grant_types ? JSON.parse(form.grant_types) : undefined,
              response_types: form.response_types ? JSON.parse(form.response_types) : undefined,
            };
          }
        } catch {
          throw new OAuthError('invalid_client_metadata', 'Invalid registration document.');
        }
        const parsed = registration.safeParse(value);
        if (!parsed.success) throw new OAuthError('invalid_client_metadata', 'Invalid registration document.');
        return json(201, await this.authority.register(parsed.data, arrival));
      }
      const auth = credentials(request, formValues(text));
      if (path === '/oauth/token') {
        const parsed = exchange.safeParse(auth.body);
        if (!parsed.success) throw new OAuthError('invalid_request', 'Missing or invalid token parameters.');
        return json(200, await this.authority.exchange({ ...parsed.data, authMethod: auth.authMethod }, arrival));
      }
      const parsed = revocation.safeParse(auth.body);
      if (!parsed.success) throw new OAuthError('invalid_request', 'Missing or invalid revocation parameters.');
      await this.authority.revokeToken({ ...parsed.data, authMethod: auth.authMethod }, arrival);
      return json(200, {});
    } catch (error) {
      const failure =
        error instanceof OAuthError
          ? error
          : error instanceof BodyTooLargeError
            ? new OAuthError('invalid_request', 'Request body exceeds 8 KiB.', 413)
            : new OAuthError('server_error', 'The connector could not complete this request.', 503);
      // RFC 6749 §4.1.2.1: a protocol error after client and redirect_uri are trusted goes back to the client.
      if (failure.redirectTo !== undefined) return redirect(failure.redirectTo);
      if (!html && (failure.status === 429 || failure.retryAfter !== undefined))
        return json(failure.status, { error: failure.error, error_description: failure.description }, [
          ['retry-after', String(failure.retryAfter ?? 60)],
        ]);
      return html
        ? failurePage(failure, this.endpoints)
        : json(failure.status, { error: failure.error, error_description: failure.description });
    }
  }
}
