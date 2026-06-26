import { WebSocket } from "ws";
import { broadcast, clearClients, createWsServer, getConnectedClientCount } from "../ws";
import { createServer } from "http";

function openClient(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(data.toString()));
  });
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("WebSocket broadcast server", () => {
  let httpServer: ReturnType<typeof createServer>;
  let serverUrl: string;

  beforeEach((done) => {
    clearClients();
    httpServer = createServer();
    createWsServer(httpServer);
    httpServer.listen(0, () => {
      const addr = httpServer.address() as { port: number };
      serverUrl = `ws://localhost:${addr.port}/events`;
      done();
    });
  });

  afterEach((done) => {
    clearClients();
    httpServer.close(done);
  });

  it("broadcasts an event to a connected client", async () => {
    const ws = await openClient(serverUrl);
    const messagePromise = nextMessage(ws);

    broadcast({ type: "proposal_created", data: { id: "1", proposer: "GABC" } });

    const raw = await messagePromise;
    const msg = JSON.parse(raw);
    expect(msg.type).toBe("proposal_created");
    expect(msg.data.id).toBe("1");
    ws.close();
  });

  it("broadcasts to multiple connected clients", async () => {
    const ws1 = await openClient(serverUrl);
    const ws2 = await openClient(serverUrl);
    const p1 = nextMessage(ws1);
    const p2 = nextMessage(ws2);

    broadcast({ type: "vote_cast", data: { proposal_id: "2", voter: "GXYZ" } });

    const [m1, m2] = await Promise.all([p1, p2]);
    expect(JSON.parse(m1).type).toBe("vote_cast");
    expect(JSON.parse(m2).type).toBe("vote_cast");
    ws1.close();
    ws2.close();
  });

  it("filters by event type when client sends a filter message", async () => {
    const ws = await openClient(serverUrl);

    ws.send(JSON.stringify({ types: ["proposal_queued"] }));
    await waitMs(50);

    broadcast({ type: "vote_cast", data: { proposal_id: "3" } });

    let received = false;
    ws.once("message", () => { received = true; });
    await waitMs(100);
    expect(received).toBe(false);

    const messagePromise = nextMessage(ws);
    broadcast({ type: "proposal_queued", data: { proposal_id: "3" } });
    const raw = await messagePromise;
    expect(JSON.parse(raw).type).toBe("proposal_queued");
    ws.close();
  });

  it("filters by proposalId when client sends a filter message", async () => {
    const ws = await openClient(serverUrl);

    ws.send(JSON.stringify({ proposalId: "5" }));
    await waitMs(50);

    broadcast({ type: "vote_cast", data: { proposal_id: "6", voter: "G1" } });

    let received = false;
    ws.once("message", () => { received = true; });
    await waitMs(100);
    expect(received).toBe(false);

    const messagePromise = nextMessage(ws);
    broadcast({ type: "vote_cast", data: { proposal_id: "5", voter: "G2" } });
    const raw = await messagePromise;
    expect(JSON.parse(raw).data.proposal_id).toBe("5");
    ws.close();
  });

  it("removes client from set on disconnect", async () => {
    const ws = await openClient(serverUrl);
    expect(getConnectedClientCount()).toBe(1);

    await new Promise<void>((resolve) => {
      ws.once("close", resolve);
      ws.close();
    });
    await waitMs(50);
    expect(getConnectedClientCount()).toBe(0);
  });

  it("does not throw when no clients are connected", () => {
    expect(() => {
      broadcast({ type: "proposal_executed", data: { proposal_id: "1" } });
    }).not.toThrow();
  });

  it("ignores malformed filter messages without disconnecting client", async () => {
    const ws = await openClient(serverUrl);
    ws.send("not-valid-json");
    await waitMs(50);

    const messagePromise = nextMessage(ws);
    broadcast({ type: "proposal_created", data: { id: "10" } });
    const raw = await messagePromise;
    expect(JSON.parse(raw).type).toBe("proposal_created");
    ws.close();
  });
});
