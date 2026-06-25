/**
 * Live-refresh client (W17).
 *
 * A thin wrapper over the browser EventSource that connects to the
 * companion's `/api/events` SSE stream and invokes `onRefresh` whenever the
 * watched repo's commit graph changes. EventSource already reconnects on
 * its own, but it gives up permanently once the server is gone for good; we
 * layer a capped exponential backoff (shared `reconnectDelay`) so the app
 * keeps trying after the companion restarts, and surfaces a connected /
 * disconnected status the chrome can reflect.
 *
 * The reconnect maths is the shared, unit-tested `reconnectDelay`; this
 * module owns only the EventSource side effects + the DOM-free status
 * callback.
 */

import { reconnectDelay } from '@shared/repoWatch';

export type LiveStatus = 'connecting' | 'connected' | 'disconnected';

export interface LiveClientOptions {
  /** Fired (debounced server-side) when the repo graph changes. */
  onRefresh: (data: { repo: string; head: string; at: number }) => void;
  /** Fired whenever the connection status changes. */
  onStatus?: (status: LiveStatus) => void;
  /** The repo path to watch (passed through as ?repo=). */
  repo?: string | null;
  /** Override the events URL (tests). Default `/api/events`. */
  url?: string;
}

export class LiveClient {
  private opts: LiveClientOptions;
  private source: EventSource | null = null;
  private attempt = 0;
  private retryTimer: number | undefined;
  private status: LiveStatus = 'disconnected';
  private stopped = false;

  constructor(opts: LiveClientOptions) {
    this.opts = opts;
  }

  /** Open the stream. Safe to call once; use restart() to change repo. */
  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Close the stream + cancel any pending reconnect. */
  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.closeSource();
    this.setStatus('disconnected');
  }

  /** Reconnect, e.g. after the active repo changed. */
  restart(repo: string | null): void {
    this.opts.repo = repo;
    this.attempt = 0;
    this.stop();
    this.start();
  }

  getStatus(): LiveStatus {
    return this.status;
  }

  private connect(): void {
    if (this.stopped || typeof EventSource === 'undefined') return;
    this.closeSource();
    this.setStatus('connecting');

    const base = this.opts.url ?? '/api/events';
    const url = this.opts.repo ? `${base}?repo=${encodeURIComponent(this.opts.repo)}` : base;
    const es = new EventSource(url);
    this.source = es;

    es.addEventListener('open', () => {
      this.attempt = 0;
      this.setStatus('connected');
    });
    es.addEventListener('hello', () => this.setStatus('connected'));
    es.addEventListener('refresh', e => {
      this.setStatus('connected');
      try {
        const data = JSON.parse((e as MessageEvent).data);
        this.opts.onRefresh(data);
      } catch {
        // A malformed frame still signals "something changed" — refresh blind.
        this.opts.onRefresh({ repo: '', head: '', at: Date.now() });
      }
    });
    es.addEventListener('error', () => {
      // EventSource transitions to CLOSED on a hard failure; reconnect with
      // backoff. A transient drop (readyState CONNECTING) is left to the
      // browser's own retry.
      if (es.readyState === EventSource.CLOSED) this.scheduleReconnect();
      else this.setStatus('connecting');
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.closeSource();
    this.setStatus('disconnected');
    const delay = reconnectDelay(this.attempt++);
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private closeSource(): void {
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }

  private setStatus(status: LiveStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }
}
