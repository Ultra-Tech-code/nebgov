var mockScValToNative = jest.fn();
var mockNativeToScVal = jest.fn();
var mockSimulate = jest.fn();
var mockGetAccount = jest.fn();
var mockIsSimulationError = jest.fn();

import { GovernorClient } from "../governor";

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  return {
    ...actual,
    scValToNative: mockScValToNative,
    nativeToScVal: mockNativeToScVal,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => ({
        simulateTransaction: mockSimulate,
        getAccount: mockGetAccount,
      })),
      Api: {
        ...actual.SorobanRpc.Api,
        isSimulationError: mockIsSimulationError,
      },
    },
    Contract: jest.fn().mockImplementation(() => ({
      call: jest.fn().mockReturnValue({}),
      contractId: jest.fn().mockReturnValue("CAAA"),
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
  };
});

describe("GovernorClient listProposals", () => {
  const governorAddress = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const simulationAccount = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";

  beforeEach(() => {
    jest.clearAllMocks();
    const { Account } = require("@stellar/stellar-sdk");
    mockGetAccount.mockResolvedValue(new Account(simulationAccount, "1"));
    mockNativeToScVal.mockReturnValue({});
    mockIsSimulationError.mockReturnValue(false);
  });

  it("uses get_proposal_list when contract supports it", async () => {
    const client = new GovernorClient({
      governorAddress,
      timelockAddress: governorAddress,
      votesAddress: governorAddress,
      network: "testnet",
      simulationAccount,
    });

    mockSimulate.mockResolvedValueOnce({ result: { retval: {} } });
    mockScValToNative.mockReturnValueOnce([
      { id: 1n, description: "p1" },
      { id: 2n, description: "p2" },
    ]);

    const proposals = await client.listProposals(0, 2);

    expect(proposals).toHaveLength(2);
    expect(proposals[0].id).toBe(1n);
    expect(proposals[1].id).toBe(2n);
  });

  it("falls back to proposal_count/get_proposal when get_proposal_list is unavailable", async () => {
    const client = new GovernorClient({
      governorAddress,
      timelockAddress: governorAddress,
      votesAddress: governorAddress,
      network: "testnet",
      simulationAccount,
    });

    mockSimulate
      .mockResolvedValueOnce({ error: "unknown function get_proposal_list" })
      .mockResolvedValueOnce({ result: { retval: {} } })
      .mockResolvedValueOnce({ result: { retval: {} } })
      .mockResolvedValueOnce({ result: { retval: {} } });
    mockIsSimulationError
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false);
    mockScValToNative
      .mockReturnValueOnce(3)
      .mockReturnValueOnce({ id: 2n, description: "p2" })
      .mockReturnValueOnce({ id: 3n, description: "p3" });

    const proposals = await client.listProposals(1, 2);

    expect(proposals).toHaveLength(2);
    expect(proposals[0].id).toBe(2n);
    expect(proposals[1].id).toBe(3n);
  });
});
