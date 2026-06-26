var mockSimulate = jest.fn();
var mockGetAccount = jest.fn();
var mockPrepareTransaction = jest.fn();
var mockSendTransaction = jest.fn();
var mockGetTransaction = jest.fn();

import { FactoryClient } from "../factory";
import { xdr } from "@stellar/stellar-sdk";
import type { FactoryConfig } from "../types";
import { VoteType } from "../types";

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => ({
        simulateTransaction: mockSimulate,
        getAccount: mockGetAccount,
        prepareTransaction: mockPrepareTransaction,
        sendTransaction: mockSendTransaction,
        getTransaction: mockGetTransaction,
      })),
      Api: {
        ...actual.SorobanRpc.Api,
        isSimulationError: jest.fn(() => false),
      },
    },
    Contract: jest.fn().mockImplementation((address) => ({
      call: jest.fn().mockReturnValue({}),
      contractId: jest.fn().mockReturnValue(address),
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
    nativeToScVal: jest.fn(),
    scValToNative: jest.fn(),
    Networks: actual.Networks,
    BASE_FEE: actual.BASE_FEE,
    xdr: actual.xdr,
  };
});

const { scValToNative } = require("@stellar/stellar-sdk");
const { SorobanRpc } = require("@stellar/stellar-sdk");

describe("FactoryClient", () => {
  const config: FactoryConfig = {
    factoryAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB",
    network: "testnet",
    rpcUrl: "https://soroban-testnet.stellar.org",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue({});
    mockPrepareTransaction.mockResolvedValue({ sign: jest.fn() });
    mockSendTransaction.mockResolvedValue({ hash: "HASH123" });
    mockGetTransaction.mockResolvedValue({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS, returnValue: xdr.ScVal.scvU64(new xdr.Uint64(1n)) });
    SorobanRpc.Api.isSimulationError.mockReturnValue(false);
  });

  it("fetches the governor count", async () => {
    const response = {
      result: { retval: xdr.ScVal.scvU64(new xdr.Uint64(3n)) },
    };
    mockSimulate.mockResolvedValue(response);
    scValToNative.mockReturnValue(3n);

    const client = new FactoryClient(config);
    const count = await client.getGovernorCount();

    expect(count).toBe(3n);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it("fetches a governor entry by id", async () => {
    const rawEntry = {
      id: 2n,
      governor: "GDUMMY",
      timelock: "GDUMMY2",
      token: "GDUMMY3",
      deployer: "GDUMMY4",
    };

    const response = { result: { retval: xdr.ScVal.scvMap([]) } };
    mockSimulate.mockResolvedValue(response);
    scValToNative.mockReturnValue(rawEntry);

    const client = new FactoryClient(config);
    const entry = await client.getGovernor(2n);

    expect(entry).toEqual(rawEntry);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
  });

  it("fetches all governors in pages of 50 when count exceeds 50", async () => {
    const responseCount = {
      result: { retval: xdr.ScVal.scvU64(new xdr.Uint64(55n)) },
    };
    const responseEntry = { result: { retval: xdr.ScVal.scvMap([]) } };
    mockSimulate.mockResolvedValueOnce(responseCount);
    for (let i = 0; i < 55; i += 1) {
      mockSimulate.mockResolvedValueOnce(responseEntry);
    }

    scValToNative.mockImplementation((raw: unknown) => {
      if (typeof raw === "object" && raw?.toString?.() === "ScVal") {
        return { id: 1n, governor: "G1", timelock: "T1", token: "TO1", deployer: "D1" };
      }
      return 55n;
    });

    const client = new FactoryClient(config);
    const entries = await client.getAllGovernors();

    expect(entries).toHaveLength(55);
    expect(entries[0]).toEqual({
      id: 1n,
      governor: "G1",
      timelock: "T1",
      token: "TO1",
      deployer: "D1",
    });
  });

  it("fetches a limited governor list with offset", async () => {
    const responseCount = {
      result: { retval: xdr.ScVal.scvU64(new xdr.Uint64(10n)) },
    };
    const responseEntry = { result: { retval: xdr.ScVal.scvMap([]) } };
    mockSimulate.mockResolvedValueOnce(responseCount);
    for (let i = 0; i < 3; i += 1) {
      mockSimulate.mockResolvedValueOnce(responseEntry);
    }

    scValToNative.mockImplementation((raw: unknown) => {
      if (typeof raw === "object" && raw?.toString?.() === "ScVal") {
        return { id: 6n, governor: "G6", timelock: "T6", token: "TO6", deployer: "D6" };
      }
      return 10n;
    });

    const client = new FactoryClient(config);
    const entries = await client.getAllGovernors({ limit: 3, offset: 5 });

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      id: 6n,
      governor: "G6",
      timelock: "T6",
      token: "TO6",
      deployer: "D6",
    });
  });

  it("deploys a new governor and returns the new id", async () => {
    mockGetTransaction.mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      returnValue: xdr.ScVal.scvU64(new xdr.Uint64(7n)),
    });
    scValToNative.mockReturnValue(7n);

    const client = new FactoryClient(config);
    const signer = {
      publicKey: () => "GTESTSIGNER",
    } as any;

    const id = await client.deploy(signer, "GOV_TOKEN", {
      votingDelay: 10,
      votingPeriod: 100,
      quorumNumerator: 20,
      proposalThreshold: 1000n,
      timelockDelay: 3600n,
      guardian: "GGAURDIAN",
      voteType: VoteType.Extended,
      proposalGracePeriod: 120000,
    });

    expect(id).toBe(7n);
    expect(mockPrepareTransaction).toHaveBeenCalledTimes(1);
    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    expect(mockGetTransaction).toHaveBeenCalledWith("HASH123");
  });
});
