export type WsEventType =
  | "proposal_created"
  | "vote_cast"
  | "proposal_queued"
  | "proposal_executed"
  | "delegate_changed"
  | "config_updated"
  | "governor_upgraded"
  | "wrapper_deposit"
  | "wrapper_withdrawal";

export interface IndexerEvent {
  type: WsEventType;
  data: Record<string, unknown>;
}

export interface StreamEventsOptions {
  /** Filter to specific event types. If omitted, all types are received. */
  types?: WsEventType[];
  /** Filter to a specific proposal ID. */
  proposalId?: string;
  /** Reconnect delay in ms (default 3000). */
  reconnectDelayMs?: number;
  /** Polling interval in ms used as fallback when WebSocket is unavailable (default 10000). */
  pollIntervalMs?: number;
  /** Custom fetch function for polling fallback (default: global fetch). */
  fetchFn?: typeof fetch;
}

export type UnsubscribeFn = () => void;

function buildWsUrl(indexerUrl: string): string {
  return indexerUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/events";
}

function buildPollUrl(indexerUrl: string): string {
  return indexerUrl.replace(/\/$/, "") + "/proposals?limit=20";
}

/**
 * Connects to the indexer WebSocket and calls `handler` on each matching event.
 * Falls back to polling `GET /proposals` if WebSocket is unavailable.
 * Returns an unsubscribe function that stops the stream and closes connections.
 */
export function streamEvents(
  indexerUrl: string,
  handler: (event: IndexerEvent) => void,
  opts: StreamEventsOptions = {}
): UnsubscribeFn {
  const {
    types,
    proposalId,
    reconnectDelayMs = 3000,
    pollIntervalMs = 10_000,
    fetchFn = typeof fetch !== "undefined" ? fetch : undefined,
  } = opts;

  let stopped = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let usingPolling = false;

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling() {
    if (!fetchFn || usingPolling) return;
    usingPolling = true;
    const url = buildPollUrl(indexerUrl);
    let lastSeenId: string | null = null;

    async function poll() {
      if (stopped) return;
      try {
        const res = await fetchFn!(url);
        if (!res.ok) return;
        const body = (await res.json()) as { proposals?: Array<{ id: string | number; [k: string]: unknown }> };
        const proposals = body.proposals ?? [];
        for (const p of proposals) {
          const id = String(p.id);
          if (lastSeenId !== null && id <= lastSeenId) continue;
          const event: IndexerEvent = { type: "proposal_created", data: p as Record<string, unknown> };
          if (matchesFilter(event)) handler(event);
        }
        if (proposals.length > 0) {
          lastSeenId = String(proposals[0].id);
        }
      } catch {
        /* polling best-effort */
      }
    }

    void poll();
    pollTimer = setInterval(() => void poll(), pollIntervalMs);
  }

  function matchesFilter(event: IndexerEvent): boolean {
    if (types && types.length > 0 && !types.includes(event.type)) return false;
    if (proposalId !== undefined) {
      const pid = (event.data as any).proposal_id ?? (event.data as any).id;
      if (String(pid) !== proposalId) return false;
    }
    return true;
  }

  function connect() {
    if (stopped) return;

    const WS = typeof WebSocket !== "undefined"
      ? WebSocket
      : (() => { startPolling(); return null; })();

    if (!WS) return;

    const wsUrl = buildWsUrl(indexerUrl);
    try {
      ws = new WS(wsUrl) as WebSocket;
    } catch {
      startPolling();
      return;
    }

    ws.onopen = () => {
      stopPolling();
      usingPolling = false;
      if (types || proposalId) {
        ws!.send(JSON.stringify({ types, proposalId }));
      }
    };

    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(
          typeof ev.data === "string" ? ev.data : ev.data.toString()
        ) as IndexerEvent;
        if (matchesFilter(event)) handler(event);
      } catch {
        /* ignore malformed messages */
      }
    };

    ws.onerror = () => {
      /* handled by onclose */
    };

    ws.onclose = () => {
      ws = null;
      if (stopped) return;
      startPolling();
      reconnectTimer = setTimeout(() => {
        if (!stopped) {
          stopPolling();
          usingPolling = false;
          connect();
        }
      }, reconnectDelayMs);
    };
  }

  connect();

  return function unsubscribe() {
    stopped = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    stopPolling();
    if (ws !== null) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
  };
}
