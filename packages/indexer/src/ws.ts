import { IncomingMessage, Server as HttpServer } from "http";
import { WebSocket, WebSocketServer } from "ws";

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

export interface WsEvent {
  type: WsEventType;
  data: Record<string, unknown>;
}

interface SubscriptionFilter {
  types?: WsEventType[];
  proposalId?: string;
}

interface SubscribedClient {
  socket: WebSocket;
  filter: SubscriptionFilter;
}

const clients = new Set<SubscribedClient>();

function matchesFilter(event: WsEvent, filter: SubscriptionFilter): boolean {
  if (filter.types && filter.types.length > 0) {
    if (!filter.types.includes(event.type)) return false;
  }
  if (filter.proposalId !== undefined) {
    const pid = (event.data as any).proposal_id ?? (event.data as any).id;
    if (String(pid) !== filter.proposalId) return false;
  }
  return true;
}

export function broadcast(event: WsEvent): void {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (
      client.socket.readyState === WebSocket.OPEN &&
      matchesFilter(event, client.filter)
    ) {
      client.socket.send(payload);
    }
  }
}

export function createWsServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/events" });

  wss.on("connection", (socket: WebSocket, _req: IncomingMessage) => {
    const entry: SubscribedClient = { socket, filter: {} };
    clients.add(entry);

    socket.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          types?: WsEventType[];
          proposalId?: string;
        };
        if (Array.isArray(msg.types)) entry.filter.types = msg.types;
        if (typeof msg.proposalId === "string")
          entry.filter.proposalId = msg.proposalId;
      } catch {
        /* ignore malformed filter messages */
      }
    });

    socket.on("close", () => {
      clients.delete(entry);
    });

    socket.on("error", () => {
      clients.delete(entry);
    });
  });

  return wss;
}

export function getConnectedClientCount(): number {
  return clients.size;
}

export function clearClients(): void {
  clients.clear();
}
