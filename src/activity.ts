// Requests the relay is handling right now, and the line each one leaves when
// it ends. The proxy reports start → updates → end; the server keeps the open
// ones in memory and writes them to state.json so the dashboard (a separate
// process) can show a request while it is still streaming, not only after.
import type { ActiveRequest, ActivityEvent, RequestSummary } from './types.js';

// What the proxy tells the activity log. Every call is best-effort: a sink
// that throws must never break the request it describes.
export interface ActivitySink {
  start(entry: ActiveRequest): void;
  update(id: string, patch: ActivityPatch): void;
  end(id: string, status: number | string, at?: number): void;
}

// Client-supplied text (path, later model and session) is drawn on a terminal:
// control characters would be escape sequences there, so they become spaces,
// and the length is capped so one request cannot take over a row.
export function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

export const LIMITS = { method: 16, path: 256, account: 64, model: 64, effort: 16, sessionId: 64 } as const;

export type ActivityPatch = Partial<Pick<ActiveRequest, 'account' | 'model' | 'effort' | 'sessionId' | 'group' | 'route' | 'routeFallback' | 'streamEnd' | 'capacityRetries'>>;

export function requestMessage(request: RequestSummary): string {
  const account = request.account ? ` → ${request.account}` : '';
  const model = request.model ? ` (${request.model}${request.effort ? `·${request.effort}` : ''})` : '';
  const group = request.group ? ` [group:${request.group}]` : '';
  const route = request.route ? ` [route:${request.route}${request.routeFallback ? '→fallback' : ''}]` : '';
  const ended = request.streamEnd ? ` ${request.streamEnd}` : '';
  return `${request.providerLabel} ${request.method} ${request.path}${model}${account}${group}${route} ${request.status}${ended}${request.capacityRetries ? ` capacity retry x${request.capacityRetries}` : ''} (${(request.durationMs / 1000).toFixed(1)}s)`;
}

export class ActivityLog implements ActivitySink {
  private readonly open = new Map<string, ActiveRequest>();

  // record receives each finished request as an event; changed is told that
  // the open set moved, so the caller can schedule a save.
  constructor(private readonly record: (event: ActivityEvent) => void, private readonly changed: () => void = () => {}) {}

  start(entry: ActiveRequest): void {
    this.open.set(entry.id, { ...entry, method: clean(entry.method, LIMITS.method) ?? '?', path: clean(entry.path, LIMITS.path) ?? '/' });
    this.changed();
  }

  update(id: string, patch: ActivityPatch): void {
    const entry = this.open.get(id); if (!entry) return;
    for (const key of ['account', 'model', 'effort', 'sessionId'] as const) if (key in patch) entry[key] = clean(patch[key], LIMITS[key]);
    if ('group' in patch) entry.group = clean(patch.group, LIMITS.account);
    if ('route' in patch) entry.route = clean(patch.route, LIMITS.account);
    if ('routeFallback' in patch) entry.routeFallback = patch.routeFallback === true;
    if (patch.streamEnd === 'failed' || patch.streamEnd === 'incomplete') entry.streamEnd = patch.streamEnd;
    if (patch.capacityRetries !== undefined && Number.isInteger(patch.capacityRetries) && patch.capacityRetries >= 0) entry.capacityRetries = patch.capacityRetries;
    this.changed();
  }

  end(id: string, status: number | string, at = Date.now()): void {
    const entry = this.open.get(id); if (!entry) return;
    this.open.delete(id);
    const request: RequestSummary = { provider: entry.provider, providerLabel: entry.providerLabel, method: entry.method, path: entry.path, account: entry.account, status, durationMs: Math.max(0, at - entry.startedAt), model: entry.model ?? null, effort: entry.effort ?? null, sessionId: entry.sessionId ?? null, ...(entry.group ? { group: entry.group } : {}), route: entry.route ?? null, routeFallback: entry.routeFallback ?? false, ...(entry.capacityRetries ? { capacityRetries: entry.capacityRetries } : {}), ...(entry.streamEnd ? { streamEnd: entry.streamEnd } : {}) };
    this.record({ at, message: requestMessage(request), request });
  }

  // Oldest first, which is the order they started in.
  snapshot(): ActiveRequest[] { return [...this.open.values()].map((entry) => ({ ...entry })); }

  get size(): number { return this.open.size; }
}
