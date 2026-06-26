import { GovernorClient } from "../governor";
import { TimelockClient } from "../timelock";
import { VoteSupport } from "../types";

// Mocking Stellar SDK
var mockSimulate = jest.fn();
var mockGetAccount = jest.fn();
var mockPrepareTransaction = jest.fn();
var mockSendTransaction = jest.fn();
var mockGetTransaction = jest.fn();
var mockIsSimulationError = jest.fn();
var mockScValToNative = jest.fn();

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    scValToNative: (...args: unknown[]) => mockScValToNative(...args),
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => ({
        simulateTransaction: (...args: unknown[]) => mockSimulate(...args),
        getAccount: (...args: unknown[]) => mockGetAccount(...args),
        prepareTransaction: (...args: unknown[]) => mockPrepareTransaction(...args),
        sendTransaction: (...args: unknown[]) => mockSendTransaction(...args),
        getTransaction: (...args: unknown[]) => mockGetTransaction(...args),
        getLatestLedger: jest.fn().mockResolvedValue({ sequence: 123 }),
      })),
      Api: {
        ...actual.SorobanRpc.Api,
        isSimulationError: (...args: unknown[]) => mockIsSimulationError(...args),
      },
    },
    Contract: jest.fn().mockImplementation((addr) => ({
      call: jest.fn().mockReturnValue({}),
      address: () => addr,
      contractId: () => "CAAA",
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
  };
});

const VALID_DESC_HASH = "0".repeat(64);

describe("SDK Retry Logic", () => {
  let client: GovernorClient;
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const mockSigner = { sign: jest.fn(), publicKey: () => validGAddr } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    const { Account } = require("@stellar/stellar-sdk");
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    mockIsSimulationError.mockReturnValue(false);
    mockGetTransaction.mockResolvedValue({ status: "SUCCESS", returnValue: {} });

    client = new GovernorClient({
      governorAddress: validCAddr,
      timelockAddress: validCAddr,
      votesAddress: validCAddr,
      network: "testnet",
      maxAttempts: 3,
      baseDelayMs: 1,
    });
  });

  it("should retry read-only methods on network error", async () => {
    mockSimulate
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockRejectedValueOnce(new Error("request failed"))
      .mockResolvedValue({
        result: { retval: {} },
      });
    mockScValToNative.mockReturnValue(["Active"]);

    const state = await client.getProposalState(1n);

    expect(mockSimulate).toHaveBeenCalledTimes(3);
    expect(state).toBeDefined();
  }, 10_000);

  it("should retry submission methods on network error", async () => {
    mockPrepareTransaction
      .mockRejectedValueOnce(new Error("Network timeout"))
      .mockResolvedValue({ sign: jest.fn() });

    mockSendTransaction.mockResolvedValue({
      status: "PENDING",
      hash: "tx123",
    });
    mockScValToNative.mockReturnValue(42n);

    const id = await client.propose(
      mockSigner,
      "Title",
      VALID_DESC_HASH,
      "uri",
      [validCAddr],
      ["fn"],
      [Buffer.from([])],
    );

    expect(mockPrepareTransaction).toHaveBeenCalledTimes(2);
    expect(id).toBe(42n);
  }, 10_000);

  it("should NOT retry submission methods on contract error", async () => {
    mockPrepareTransaction.mockResolvedValue({ sign: jest.fn() });
    mockSendTransaction.mockResolvedValue({
      status: "ERROR",
      error: "Error(Contract, #101)",
    });

    await expect(
      client.castVote(mockSigner, 1n, VoteSupport.For),
    ).rejects.toThrow();

    // Should only attempt once because it's a contract error, not a network error
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("should NOT retry submission methods on TransactionAlreadyInMempool", async () => {
    mockPrepareTransaction.mockResolvedValue({ sign: jest.fn() });
    mockSendTransaction.mockResolvedValue({
      status: "ERROR",
      error: "TransactionAlreadyInMempool",
    });

    await expect(
      client.castVote(mockSigner, 1n, VoteSupport.For),
    ).rejects.toThrow();

    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("should retry submission methods on 5xx server error", async () => {
    mockPrepareTransaction.mockResolvedValue({ sign: jest.fn() });
    mockSendTransaction
      .mockRejectedValueOnce(new Error("Internal Server Error (500)"))
      .mockResolvedValue({
        status: "PENDING",
        hash: "tx123",
      });

    await client.castVote(mockSigner, 1n, VoteSupport.For);

    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  }, 10_000);
});

describe("SDK Retry Logic — TimelockClient.execute() 503 recovery", () => {
  let timelockClient: TimelockClient;
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const opId = "a".repeat(64);
  const mockSigner = { sign: jest.fn(), publicKey: () => validGAddr } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    const { Account } = require("@stellar/stellar-sdk");
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    mockIsSimulationError.mockReturnValue(false);
    mockGetTransaction.mockResolvedValue({ status: "SUCCESS", returnValue: {} });

    timelockClient = new TimelockClient({
      governorAddress: validCAddr,
      timelockAddress: validCAddr,
      votesAddress: validCAddr,
      network: "testnet",
      maxAttempts: 3,
      baseDelayMs: 1,
    });
  });

  it("should retry execute() on 503 and succeed on the next attempt", async () => {
    mockPrepareTransaction.mockResolvedValue({ sign: jest.fn() });
    mockSendTransaction
      .mockRejectedValueOnce(new Error("Service Unavailable 503"))
      .mockResolvedValue({ status: "PENDING", hash: "txExec1" });

    await timelockClient.execute(mockSigner, opId);

    expect(mockSendTransaction).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("should respect maxAttempts and stop retrying execute() after exhausting retries", async () => {
    mockPrepareTransaction.mockResolvedValue({ sign: jest.fn() });
    mockSendTransaction.mockRejectedValue(new Error("Service Unavailable 503"));

    await expect(
      timelockClient.execute(mockSigner, opId),
    ).rejects.toThrow("Service Unavailable 503");

    expect(mockSendTransaction).toHaveBeenCalledTimes(3);
  });

  it("should surface the final 503 error to the caller after exhausting retries", async () => {
    mockPrepareTransaction.mockResolvedValue({ sign: jest.fn() });
    const rpcError = new Error("Service Unavailable 503");
    mockSendTransaction.mockRejectedValue(rpcError);

    const thrown = await timelockClient
      .execute(mockSigner, opId)
      .catch((e) => e);

    expect(thrown).toBe(rpcError);
    expect(thrown.message).toContain("503");
  });
});
