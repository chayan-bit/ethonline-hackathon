import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { Config } from '../adapters/config.ts';
import { Auth, bodyHash, type AuthProof, type AuthScope } from './auth.ts';
import type { Gateway, Purchase } from './gateway.ts';
import type { Store } from './store.ts';
import { computeMetrics } from '../protocol/metrics.ts';
import { DEFAULT_POLICY, selectProvider, type DiscoveryPolicy } from '../protocol/discovery.ts';
import { SCHEMA, signalSchema } from '../protocol/signal.ts';
import type { SampleEvidence } from './indexer.ts';
import { providerMetadata } from './metadata.ts';

type AppContext = { config: Config; store: Store; gateway: Pick<Gateway, 'quote' | 'purchase'>; auth: Auth; seller: () => Promise<{ active: boolean }> };
type RequestContext = { req: IncomingMessage; res: ServerResponse; url: URL; raw: string; json: unknown };
const STATIC_FILES: Record<string, [string, string]> = { '/': ['web/index.html', 'text/html'], '/app.js': ['web/app.js', 'text/javascript'], '/style.css': ['web/style.css', 'text/css'] };
const errorCodes = ['invalid_', 'unknown_', 'quote_', 'request_', 'payer_', 'payment_', 'policy_', 'inactive_', 'unsafe_', 'registry_'];

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage) {
  let raw = '';
  let length = 0;
  for await (const chunk of req) {
    length += Buffer.byteLength(chunk);
    if (length > 128_000) throw new Error('invalid_body_size');
    raw += chunk.toString();
  }
  if (raw && !/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']))) throw new Error('invalid_content_type');
  try { return { raw, json: raw ? JSON.parse(raw) : null }; } catch { throw new Error('invalid_json'); }
}

function headerJson<T>(req: IncomingMessage, name: string): T {
  const value = req.headers[name];
  if (typeof value !== 'string' || value.length > 100_000 || !/^[A-Za-z0-9+/]+=*$/.test(value)) throw new Error(name === 'x-wallet-proof' ? 'invalid_auth' : 'invalid_payment_header');
  try { return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as T; } catch { throw new Error('invalid_header_json'); }
}

function policyFrom(url: URL): DiscoveryPolicy {
  const optional = (name: string) => url.searchParams.has(name) ? Number(url.searchParams.get(name)) : undefined;
  return { ...DEFAULT_POLICY, min_samples: optional('min_samples') ?? DEFAULT_POLICY.min_samples,
    min_reveal_pct: optional('min_reveal_pct') ?? DEFAULT_POLICY.min_reveal_pct, max_price: url.searchParams.get('max_price') ?? DEFAULT_POLICY.max_price,
    allow_unproven: url.searchParams.get('allow_unproven') === 'true', feed: url.searchParams.get('feed') ?? undefined,
    max_mae_bps: optional('max_mae_bps'), min_grade_coverage_pct: optional('min_grade_coverage_pct'), min_hit_rate_pct: optional('min_hit_rate_pct') };
}

function publicPurchase(p: Purchase) {
  return { request_id: p.quote.request.request_id, agent_id: p.quote.request.agent_id, status: p.status, target_time: p.quote.request.target_time,
    amount: p.quote.requirements.amount, asset: p.quote.requirements.asset, payment_ref: p.payment_ref ?? null,
    commitment_hash: p.prepared?.hash ?? null, commitment_transaction_id: p.commitment?.transaction_id ?? null, error: p.error ?? null };
}

async function provider(context: AppContext, url: URL) {
  const { config, store } = context;
  const status = store.get<{ indexed_through: number }>('indexer', 'status');
  const metadata = providerMetadata(config);
  const metrics = computeMetrics(store.list<SampleEvidence>('samples'), { agentId: config.agentId, indexedThrough: status?.indexed_through ?? 0,
    computedAt: Math.floor(Date.now() / 1000), feed: url.searchParams.get('feed') ?? undefined });
  let active = false;
  let registry_error: string | null = null;
  try { active = (await context.seller()).active; } catch { registry_error = 'registry_unavailable_or_metadata_mismatch'; }
  return { ...metadata, active, registry_error, metrics };
}

async function privateRoutes(ctx: AppContext, r: RequestContext): Promise<boolean> {
  const path = r.url.pathname;
  if (r.req.method === 'POST' && path === '/v1/auth/challenges') {
    send(r.res, 200, ctx.auth.issue(r.json as AuthScope)); return true;
  }
  if (r.req.method === 'POST' && path === '/v1/signals') {
    const quote = await ctx.gateway.quote(r.json);
    if (!r.req.headers['payment-signature']) {
      const required = { x402Version: 2, resource: { url: `${ctx.config.baseUrl}/v1/signals`, description: 'A committed, non-exclusive ETH/USD forecast', mimeType: 'application/json' }, accepts: [quote.requirements] };
      send(r.res, 402, { ...required, quote }, { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(required)).toString('base64') }); return true;
    }
    await ctx.auth.verify(headerJson<AuthProof>(r.req, 'x-wallet-proof'), { buyer: quote.request.buyer, request_id: quote.request.request_id, method: 'POST', path, body_hash: bodyHash(r.raw) });
    const result = await ctx.gateway.purchase(quote.request.request_id, headerJson(r.req, 'payment-signature'));
    send(r.res, result.status === 'delivered' ? 200 : 202, result,
      result.status === 'delivered' ? { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: true, transaction: result.payment_ref, network: ctx.config.network })).toString('base64') } : {});
    return true;
  }
  const match = /^\/v1\/purchases\/(0x[0-9a-f]{64})$/.exec(path);
  if (r.req.method === 'GET' && match) {
    const proof = headerJson<AuthProof>(r.req, 'x-wallet-proof');
    const purchase = ctx.store.purchase(match[1]);
    if (!purchase) { send(r.res, 404, { error: 'unknown_request' }); return true; }
    await ctx.auth.verify(proof, { buyer: purchase.quote.request.buyer, request_id: match[1], method: 'GET', path, body_hash: bodyHash('') });
    send(r.res, 200, purchase); return true;
  }
  return false;
}

async function publicRoutes(ctx: AppContext, r: RequestContext): Promise<boolean> {
  if (r.req.method !== 'GET') return false;
  const path = r.url.pathname;
  if (path === '/health') {
    send(r.res, 200, { live: true, network: ctx.config.network, contracts_configured: Boolean(ctx.config.registryAddress && ctx.config.ledgerAddress),
      oracle_api_configured: Boolean(ctx.config.pythApiKey), indexer: ctx.store.get('indexer', 'status'), worker_enabled: ctx.config.workerEnabled }); return true;
  }
  if (path === `/v1/schema/${SCHEMA}`) { send(r.res, 200, signalSchema); return true; }
  if (path === `/v1/metadata/${ctx.config.agentId}`) { send(r.res, 200, providerMetadata(ctx.config)); return true; }
  if (path === '/.well-known/agent-card.json') {
    send(r.res, 200, { name: 'ETH Momentum', description: 'x402 forecast service; REST discovery card. Full A2A messaging is not yet implemented.',
      url: `${ctx.config.baseUrl}/v1/signals`, version: '0.1.0', capabilities: { streaming: false }, defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
      skills: [{ id: SCHEMA, name: 'ETH/USD return forecast', description: 'Non-exclusive committed forecast', tags: ['defi','forecast','x402'] }], metadata: providerMetadata(ctx.config) }); return true;
  }
  if (path === '/v1/agents') {
    const agent = await provider(ctx, r.url);
    const policy = policyFrom(r.url);
    const selection = selectProvider([agent], policy);
    send(r.res, 200, { agents: [agent], policy, selected_agent_id: selection.selected?.agent_id ?? null, decisions: selection.decisions.map(d => ({ agent_id: d.provider.agent_id, reasons: d.reasons })), status: selection.status }); return true;
  }
  if (path === `/v1/agents/${ctx.config.agentId}`) { send(r.res, 200, await provider(ctx, r.url)); return true; }
  if (path === `/v1/agents/${ctx.config.agentId}/signals`) {
    const offset = Number(r.url.searchParams.get('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid_offset');
    const samples = ctx.store.list<SampleEvidence>('samples').sort((a, b) => b.committed_at - a.committed_at);
    send(r.res, 200, { samples: samples.slice(offset, offset + 50), next_offset: samples.length > offset + 50 ? offset + 50 : null }); return true;
  }
  if (path === '/v1/activity') { send(r.res, 200, { purchases: ctx.store.purchases().map(publicPurchase), jobs: ctx.store.list('jobs') }); return true; }
  const signal = /^\/v1\/signals\/(0x[0-9a-f]{64})$/.exec(path);
  if (signal) {
    const sample = ctx.store.get<SampleEvidence>('samples', signal[1]);
    send(r.res, sample ? 200 : 404, sample ?? { error: 'unknown_signal' }); return true;
  }
  return false;
}

export function createApp(ctx: AppContext) {
  const rates = new Map<string, { count: number; reset: number }>();
  return createServer({ requestTimeout: 30000, headersTimeout: 15000 }, async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', ctx.config.baseUrl);
      const ip = req.socket.remoteAddress ?? 'unknown';
      const now = Date.now();
      const rate = rates.get(ip);
      const nextRate = !rate || rate.reset < now ? { count: 1, reset: now + 60000 } : { ...rate, count: rate.count + 1 };
      rates.set(ip, nextRate);
      if (nextRate.count > 120) { send(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' }); return; }
      if (rates.size > 10000) for (const [key, value] of rates) if (value.reset < now) rates.delete(key);
      const staticFile = STATIC_FILES[url.pathname];
      if (req.method === 'GET' && staticFile) {
        const content = await readFile(staticFile[0]);
        res.writeHead(200, { 'Content-Type': staticFile[1], 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
        res.end(content); return;
      }
      const r = { req, res, url, ...await body(req) };
      if (await privateRoutes(ctx, r) || await publicRoutes(ctx, r)) return;
      send(res, 404, { error: 'not_found' });
    } catch (error) {
      const message = error instanceof Error ? error.message.split(':')[0] : '';
      const code = errorCodes.some(prefix => message.startsWith(prefix)) ? message : 'service_unavailable';
      send(res, code === 'invalid_auth' ? 401 : code === 'service_unavailable' ? 503 : 400, { error: code });
      if (code === 'service_unavailable') console.error(JSON.stringify({ event: 'request_failed', path: req.url?.split('?')[0], error: error instanceof Error ? error.name : 'unknown' }));
    }
  });
}
