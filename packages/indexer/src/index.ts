import { createServer } from "http";
import { SorobanRpc } from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import { initDb, pool } from "./db";
import { processEvents, getLastIndexedLedger, updateLastIndexedLedger } from "./events";
import { createApp } from "./api";
import { createWsServer } from "./ws";

dotenv.config();

const GOVERNOR_ADDRESS = process.env.GOVERNOR_ADDRESS ?? "";
const WRAPPER_ADDRESS = process.env.WRAPPER_ADDRESS ?? "";
const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5000);
const PORT = Number(process.env.PORT ?? 3001);

// Track indexer startup time for uptime calculation
export const startTime = Date.now();

let pollingInterval: ReturnType<typeof setInterval> | null = null;
let currentBatchPromise: Promise<void> = Promise.resolve();
let isShuttingDown = false;

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log("Shutting down gracefully...");

  if (pollingInterval !== null) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }

  // Wait for the in-flight batch to complete before closing the DB connection
  await currentBatchPromise;

  await pool.end();
  console.log("Database connections closed.");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function runIndexer(): Promise<void> {
  const server = new SorobanRpc.Server(RPC_URL, { allowHttp: false });

  const config = {
    rpcUrl: RPC_URL,
    governorAddress: GOVERNOR_ADDRESS,
    wrapperAddress: WRAPPER_ADDRESS,
    pollIntervalMs: POLL_INTERVAL_MS,
  };

  let lastLedger = await getLastIndexedLedger();

  console.log(`Starting indexer from ledger ${lastLedger}`);

  async function pollOnce(): Promise<void> {
    if (isShuttingDown) return;
    const batchPromise = (async () => {
      const latestLedger = await processEvents(server, config, lastLedger + 1);
      if (latestLedger > lastLedger) {
        await updateLastIndexedLedger(latestLedger);
        lastLedger = latestLedger;
        console.log(`Indexed up to ledger ${lastLedger}`);
      }
    })();
    currentBatchPromise = batchPromise.catch((err) => {
      console.error("Batch processing error:", err);
    });
    await currentBatchPromise;
  }

  // Run the first poll immediately, then schedule subsequent ones.
  await pollOnce();

  pollingInterval = setInterval(() => {
    currentBatchPromise = pollOnce().catch((err) => {
      console.error("Poll error:", err);
    });
  }, POLL_INTERVAL_MS);
}

async function main(): Promise<void> {
  await initDb();
  console.log("Database initialized");

  // Start REST API + WebSocket server
  const rpcServer = new SorobanRpc.Server(RPC_URL, { allowHttp: false });
  const app = createApp(rpcServer);
  const httpServer = createServer(app);
  createWsServer(httpServer);
  httpServer.listen(PORT, () => {
    console.log(`NebGov indexer API running on port ${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}/events`);
  });

  // Start indexer loop
  runIndexer().catch((err) => {
    console.error("Indexer fatal error:", err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
