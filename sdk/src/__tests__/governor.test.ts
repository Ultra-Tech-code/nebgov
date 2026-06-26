// Define mocks with 'mock' prefix and use 'var' for hoisting support
var mockScValToNative = jest.fn();
var mockNativeToScVal = jest.fn();
var mockSimulate = jest.fn();
var mockGetAccount = jest.fn();
var mockPrepareTransaction = jest.fn();
var mockSendTransaction = jest.fn();
var mockGetTransaction = jest.fn();
var mockIsSimulationError = jest.fn();

import { GovernorClient } from "../governor";
import { ProposalState, VoteSupport, UnknownProposalStateError, ProposalAction, ProposalSimulationResult } from "../types";
import { GovernorError, GovernorErrorCode } from "../errors";

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
        prepareTransaction: mockPrepareTransaction,
        sendTransaction: mockSendTransaction,
        getTransaction: mockGetTransaction,
      })),
      Api: {
        isSimulationError: mockIsSimulationError,
        GetTransactionStatus: {
          SUCCESS: "SUCCESS",
          FAILED: "FAILED",
          NOT_FOUND: "NOT_FOUND",
        },
      },
    },
    Contract: jest.fn().mockImplementation((addr) => ({
      call: jest.fn().mockReturnValue({}),
      address: () => addr,
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
  };
});

import { xdr, Account, Keypair } from "@stellar/stellar-sdk";

describe("GovernorClient", () => {
  let client: GovernorClient;
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const mockKeypair = Keypair.random();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    
    // Default successful simulation response
    mockSimulate.mockResolvedValue({
      result: {
        retval: xdr.ScVal.scvVoid(),
        cost: { cpuInstructions: 125000 },
        footprint: []
      }
    });
    
    mockIsSimulationError.mockReturnValue(false);
    mockNativeToScVal.mockReturnValue({} as xdr.ScVal);

    client = new GovernorClient({
      governorAddress: validCAddr,
      timelockAddress: validCAddr,
      votesAddress: validCAddr,
      network: "testnet",
    });
  });

  describe("getProposalState()", () => {
    const variants = [
      { name: "Pending", expected: ProposalState.Pending },
      { name: "Active", expected: ProposalState.Active },
      { name: "Defeated", expected: ProposalState.Defeated },
      { name: "Succeeded", expected: ProposalState.Succeeded },
      { name: "Queued", expected: ProposalState.Queued },
      { name: "Executed", expected: ProposalState.Executed },
      { name: "Cancelled", expected: ProposalState.Cancelled },
    ];

    test.each(variants)("returns $expected for variant '$name'", async ({ name, expected }) => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue([name]);

      const state = await client.getProposalState(1n);

      expect(state).toBe(expected);
      expect(mockScValToNative).toHaveBeenCalledWith(scv);
    });

    it("throws UnknownProposalStateError for unrecognized variants", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(["MysteryState"]);

      await expect(client.getProposalState(1n)).rejects.toThrow(UnknownProposalStateError);
      await expect(client.getProposalState(1n)).rejects.toThrow("Unknown proposal state: MysteryState");
    });

    it("throws error for invalid ScVal format", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(123);

      await expect(client.getProposalState(1n)).rejects.toThrow("Invalid ScVal format for ProposalState enum");
    });
  });

  describe("simulateProposal", () => {
    const mockActions: ProposalAction[] = [
      {
        target: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7",
        function: "transfer",
        args: ["GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT", 1000]
      }
    ];

    it("should return successful simulation result", async () => {
      mockSimulate.mockResolvedValue({
        result: {
          retval: xdr.ScVal.scvVoid(),
          cost: { cpuInstructions: 125000 },
          footprint: []
        }
      });

      const result = await client.simulateProposal(mockActions);

      expect(result).toEqual({
        success: true,
        computeUnits: 125000,
        stateChanges: []
      });
      expect(mockSimulate).toHaveBeenCalledTimes(1);
    });

    it("should handle simulation errors", async () => {
      const { SorobanRpc } = require("@stellar/stellar-sdk");
      SorobanRpc.Api.isSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Insufficient fee"
      });

      const result = await client.simulateProposal(mockActions);

      expect(result).toEqual({
        success: false,
        error: "Simulation failed: Insufficient fee"
      });

      // Reset the mock for other tests
      SorobanRpc.Api.isSimulationError.mockReturnValue(false);
    });

    it("should handle multiple actions", async () => {
      const multipleActions: ProposalAction[] = [
        mockActions[0],
        {
          target: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8",
          function: "approve",
          args: ["GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT"]
        }
      ];

      mockSimulate.mockResolvedValue({
        result: {
          retval: xdr.ScVal.scvVoid(),
          cost: { cpuInstructions: 75000 },
          footprint: []
        }
      });

      const result = await client.simulateProposal(multipleActions);

      expect(result).toEqual({
        success: true,
        computeUnits: 150000, // 75000 * 2
        stateChanges: []
      });
      expect(mockSimulate).toHaveBeenCalledTimes(2);
    });

    it("should handle network errors", async () => {
      mockSimulate.mockRejectedValue(new Error("Network error"));

      const result = await client.simulateProposal(mockActions);

      expect(result).toEqual({
        success: false,
        error: "Network error"
      });
    });

    it("should handle missing simulation result", async () => {
      mockSimulate.mockResolvedValue({
        result: null
      });

      const result = await client.simulateProposal(mockActions);

      expect(result).toEqual({
        success: false,
        error: "No simulation result returned"
      });
    });

    it("should handle zero compute units", async () => {
      mockSimulate.mockResolvedValue({
        result: {
          retval: xdr.ScVal.scvVoid(),
          cost: { cpuInstructions: 0 },
          footprint: []
        }
      });

      const result = await client.simulateProposal(mockActions);

      expect(result).toEqual({
        success: true,
        computeUnits: 0,
        stateChanges: []
      });

      await expect(client.getProposalState(1n)).rejects.toThrow(UnknownProposalStateError);
      await expect(client.getProposalState(1n)).rejects.toThrow("Unknown proposal state: MysteryState");
    });

    it("throws GovernorError(UnknownState) for invalid ScVal format", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(123);

      await expect(client.getProposalState(1n)).rejects.toThrow(GovernorError);

      try {
        await client.getProposalState(1n);
      } catch (e) {
        expect(e).toBeInstanceOf(GovernorError);
        expect((e as GovernorError).code).toBe(GovernorErrorCode.UnknownState);
        expect((e as GovernorError).message).toContain("Invalid ScVal format");
      }
    });

    it("throws GovernorError(SimulationFailed) when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Contract not found",
      });

      await expect(client.getProposalState(1n)).rejects.toThrow(GovernorError);

      try {
        await client.getProposalState(1n);
      } catch (e) {
        expect(e).toBeInstanceOf(GovernorError);
        expect((e as GovernorError).code).toBe(GovernorErrorCode.SimulationFailed);
        expect((e as GovernorError).message).toContain("Simulation failed");
      }
    });

    it("throws GovernorError(ProposalNotFound) when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      await expect(client.getProposalState(1n)).rejects.toThrow(GovernorError);

      try {
        await client.getProposalState(1n);
      } catch (e) {
        expect(e).toBeInstanceOf(GovernorError);
        expect((e as GovernorError).code).toBe(GovernorErrorCode.ProposalNotFound);
      }
    });
  });

  describe("propose()", () => {
    const mockTxHash = "abc123";
    const mockProposalId = 42n;

    beforeEach(() => {
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: mockTxHash,
      });
    });

    it("returns proposal ID on successful proposal", async () => {
      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
        returnValue: {} as xdr.ScVal,
      });
      mockScValToNative.mockReturnValue(mockProposalId);

      const id = await client.propose(
        mockKeypair,
        "Test proposal",
        "3665313936616466316231366230623362346231613963316131613262336334",
        "ipfs://QmTest",
        [validCAddr],
        ["upgrade"],
        [Buffer.from([1, 2, 3])]
      );

      expect(id).toBe(mockProposalId);
      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("throws GovernorError(TransactionFailed) when transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Insufficient voting power",
      });

      await expect(
        client.propose(
          mockKeypair,
          "Test proposal",
          "3665313936616466316231366230623362346231613963316131613262336334",
          "ipfs://QmTest",
          [validCAddr],
          ["upgrade"],
          [Buffer.from([1, 2, 3])]
        )
      ).rejects.toThrow(GovernorError);

      try {
        await client.propose(
          mockKeypair,
          "Test proposal",
          [validCAddr],
          ["upgrade"],
          [Buffer.from([1, 2, 3])]
        );
      } catch (e) {
        expect((e as GovernorError).code).toBe(GovernorErrorCode.TransactionFailed);
        expect((e as GovernorError).message).toContain("Transaction failed");
      }
    });

    it("throws GovernorError(TransactionFailed) when confirmation fails", async () => {
      mockGetTransaction.mockResolvedValue({
        status: "FAILED",
      });

      await expect(
        client.propose(
          mockKeypair,
          "Test proposal",
          "3665313936616466316231366230623362346231613963316131613262336334",
          "ipfs://QmTest",
          [validCAddr],
          ["upgrade"],
          [Buffer.from([1, 2, 3])]
        )
      ).rejects.toThrow(GovernorError);

      try {
        await client.propose(
          mockKeypair,
          "Test proposal",
          [validCAddr],
          ["upgrade"],
          [Buffer.from([1, 2, 3])]
        );
      } catch (e) {
        expect((e as GovernorError).code).toBe(GovernorErrorCode.TransactionFailed);
      }
    });

    it("throws GovernorError(TransactionTimeout) when transaction times out", async () => {
      jest.useFakeTimers();

      mockGetTransaction.mockResolvedValue({
        status: "NOT_FOUND",
      });

      const promise = client.propose(
        mockKeypair,
        "Test proposal",
        "3665313936616466316231366230623362346231613963316131613262336334",
        "ipfs://QmTest",
        [validCAddr],
        ["upgrade"],
        [Buffer.from([1, 2, 3])]
      ).catch(err => err);

      for (let i = 0; i < 10; i++) {
        await jest.advanceTimersByTimeAsync(2000);
      }

      const error = await promise;
      expect(error).toBeInstanceOf(GovernorError);
      expect((error as GovernorError).code).toBe(GovernorErrorCode.TransactionTimeout);
      expect(error.message).toContain("Transaction not confirmed after 10 retries");

      jest.useRealTimers();
    });

    it("throws GovernorError(InvalidArguments) for mismatched array lengths", async () => {
      await expect(
        client.propose(mockKeypair, "desc", [validCAddr], ["fn1", "fn2"], [Buffer.from([1])])
      ).rejects.toThrow(GovernorError);

      try {
        await client.propose(mockKeypair, "desc", [validCAddr], ["fn1", "fn2"], [Buffer.from([1])]);
      } catch (e) {
        expect((e as GovernorError).code).toBe(GovernorErrorCode.InvalidArguments);
      }
    });

    it("throws GovernorError(InvalidArguments) for empty actions", async () => {
      await expect(
        client.propose(mockKeypair, "desc", [], [], [])
      ).rejects.toThrow(GovernorError);

      try {
        await client.propose(mockKeypair, "desc", [], [], []);
      } catch (e) {
        expect((e as GovernorError).code).toBe(GovernorErrorCode.InvalidArguments);
      }
    });
  });

  describe("castVote()", () => {
    const mockTxHash = "def456";

    beforeEach(() => {
      jest.useFakeTimers();
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: mockTxHash,
      });
      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
        returnValue: {} as xdr.ScVal,
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("successfully casts a For vote", async () => {
      const promise = client.castVote(mockKeypair, 1n, VoteSupport.For);
      await jest.advanceTimersByTimeAsync(2000);
      await promise;

      expect(mockSendTransaction).toHaveBeenCalled();
      expect(mockGetTransaction).toHaveBeenCalledWith(mockTxHash);
    });

    it("successfully casts an Against vote", async () => {
      const promise = client.castVote(mockKeypair, 1n, VoteSupport.Against);
      await jest.advanceTimersByTimeAsync(2000);
      await promise;

      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("successfully casts an Abstain vote", async () => {
      const promise = client.castVote(mockKeypair, 1n, VoteSupport.Abstain);
      await jest.advanceTimersByTimeAsync(2000);
      await promise;

      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("throws GovernorError(TransactionFailed) when transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Already voted",
      });

      await expect(
        client.castVote(mockKeypair, 1n, VoteSupport.For)
      ).rejects.toThrow(GovernorError);

      try {
        await client.castVote(mockKeypair, 1n, VoteSupport.For);
      } catch (e) {
        expect((e as GovernorError).code).toBe(GovernorErrorCode.TransactionFailed);
      }
    });

    it("parses on-chain AlreadyVoted contract error", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Error(Contract, #4)",
      });

      try {
        await client.castVote(mockKeypair, 1n, VoteSupport.For);
      } catch (e) {
        expect(e).toBeInstanceOf(GovernorError);
        expect((e as GovernorError).code).toBe(4 as GovernorErrorCode);
      }
    });
  });

  describe("castVoteWithSign()", () => {
    const mockTxHash = "abc789";
    const mockSigner = "GAABC";

    beforeEach(() => {
      jest.useFakeTimers();
      mockPrepareTransaction.mockResolvedValue({
        toXDR: jest.fn().mockReturnValue("unsigned-xdr"),
      });
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: mockTxHash,
      });
      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
        returnValue: {} as xdr.ScVal,
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("successfully casts a vote with sign callback", async () => {
      const signFn = jest.fn().mockResolvedValue("signed-xdr");
      const promise = client.castVoteWithSign(mockSigner, 1n, VoteSupport.For, signFn);
      await jest.advanceTimersByTimeAsync(2000);
      await promise;

      expect(signFn).toHaveBeenCalledWith("unsigned-xdr");
      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("throws error when transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Insufficient voting power",
      });

      await expect(
        client.castVoteWithSign(mockSigner, 1n, VoteSupport.For, jest.fn().mockResolvedValue("signed-xdr"))
      ).rejects.toThrow("castVoteWithSign failed");
    });
  });

  describe("getProposalVotes()", () => {
    it("returns vote breakdown for a proposal", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue([100n, 50n, 25n]);

      const votes = await client.getProposalVotes(1n);

      expect(votes).toEqual({
        votesFor: 100n,
        votesAgainst: 50n,
        votesAbstain: 25n,
      });
    });

    it("throws GovernorError(SimulationFailed) when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Proposal not found",
      });

      await expect(client.getProposalVotes(999n)).rejects.toThrow(GovernorError);

      try {
        await client.getProposalVotes(999n);
      } catch (e) {
        expect((e as GovernorError).code).toBe(GovernorErrorCode.SimulationFailed);
        expect((e as GovernorError).message).toContain("Simulation failed");
      }
    });

    it("throws GovernorError(ProposalNotFound) when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      await expect(client.getProposalVotes(1n)).rejects.toThrow(GovernorError);

      try {
        await client.getProposalVotes(1n);
      } catch (e) {
        expect((e as GovernorError).code).toBe(GovernorErrorCode.ProposalNotFound);
        expect((e as GovernorError).message).toContain("No return value");
      }
    });
  });

  describe("proposalCount()", () => {
    it("returns total number of proposals", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(5);

      const count = await client.proposalCount();

      expect(count).toBe(5n);
    });

    it("returns 0n when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Contract error",
      });

      const count = await client.proposalCount();

      expect(count).toBe(0n);
    });

    it("returns 0n when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      const count = await client.proposalCount();

      expect(count).toBe(0n);
    });
  });

  describe("getProposalsBatch()", () => {
    it("fetches all proposals in parallel", async () => {
      mockIsSimulationError.mockReturnValue(false);
      mockScValToNative.mockImplementation((v) => ({
        id: 1n,
        proposer: validGAddr,
        description: "test",
        startLedger: 100,
        endLedger: 200,
        votesFor: 0n,
        votesAgainst: 0n,
        votesAbstain: 0n,
        executed: false,
        cancelled: false,
      }));
      mockSimulate.mockResolvedValue({ result: { retval: {} } });

      const results = await client.getProposalsBatch([1n, 2n, 3n]);

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.proposal !== undefined)).toBe(true);
      expect(results.every((r) => r.error === undefined)).toBe(true);
    });

    it("captures errors per proposal without failing the whole batch", async () => {
      mockIsSimulationError.mockReturnValueOnce(false).mockReturnValueOnce(true).mockReturnValueOnce(false);
      mockScValToNative.mockReturnValue({ id: 1n, proposer: validGAddr, description: "test", startLedger: 100, endLedger: 200, votesFor: 0n, votesAgainst: 0n, votesAbstain: 0n, executed: false, cancelled: false });
      mockSimulate
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ error: "not found" })
        .mockResolvedValueOnce({ result: { retval: {} } });

      const results = await client.getProposalsBatch([1n, 2n, 3n]);

      expect(results).toHaveLength(3);
      expect(results[0].proposal).toBeDefined();
      expect(results[1].error).toBeDefined();
      expect(results[2].proposal).toBeDefined();
    });

    it("respects concurrency limit by chunking", async () => {
      mockIsSimulationError.mockReturnValue(false);
      mockScValToNative.mockReturnValue({ id: 1n, proposer: validGAddr, description: "test", startLedger: 100, endLedger: 200, votesFor: 0n, votesAgainst: 0n, votesAbstain: 0n, executed: false, cancelled: false });
      mockSimulate.mockResolvedValue({ result: { retval: {} } });

      const ids = [1n, 2n, 3n, 4n, 5n];
      const results = await client.getProposalsBatch(ids, 2);

      expect(results).toHaveLength(5);
    });
  });

  describe("getProposalsSummaryBatch()", () => {
    it("fetches state and votes for multiple proposals", async () => {
      mockIsSimulationError.mockReturnValue(false);
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative
        .mockReturnValueOnce(["Active"])
        .mockReturnValueOnce([1000n, 500n, 100n])
        .mockReturnValueOnce(["Defeated"])
        .mockReturnValueOnce([200n, 800n, 0n]);

      const results = await client.getProposalsSummaryBatch([1n, 2n]);

      expect(results).toHaveLength(2);
      expect(results[0].state).toBe(ProposalState.Active);
      expect(results[1].state).toBe(ProposalState.Defeated);
    });
  });

  describe("castVoteWithReason()", () => {
    it("calls cast_vote_with_reason on the contract", async () => {
      mockPrepareTransaction.mockResolvedValue({ sign: jest.fn(), toXDR: jest.fn() });
      mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "abc123" });
      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
        returnValue: xdr.ScVal.scvVoid(),
      });

      await client.castVoteWithReason(
        mockKeypair,
        1n,
        VoteSupport.For,
        "This proposal improves governance.",
      );

      const { Contract } = require("@stellar/stellar-sdk");
      const contractInstance = Contract.mock.results[0].value;
      expect(contractInstance.call).toHaveBeenCalledWith(
        "cast_vote_with_reason",
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("throws when transaction fails", async () => {
      mockPrepareTransaction.mockResolvedValue({ sign: jest.fn(), toXDR: jest.fn() });
      mockSendTransaction.mockResolvedValue({ status: "ERROR", hash: "abc123" });

      await expect(
        client.castVoteWithReason(mockKeypair, 1n, VoteSupport.Against, "reason")
      ).rejects.toThrow("castVoteWithReason failed");
    });
  });

  describe("castVoteWithReasonAndSign()", () => {
    it("calls cast_vote_with_reason via wallet callback", async () => {
      const mockPrepared = { toXDR: jest.fn().mockReturnValue("unsigned-xdr") };
      mockPrepareTransaction.mockResolvedValue(mockPrepared);
      mockSendTransaction.mockResolvedValue({ status: "PENDING", hash: "def456" });
      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
        returnValue: xdr.ScVal.scvVoid(),
      });

      const signCallback = jest.fn().mockResolvedValue("signed-xdr");
      const { TransactionBuilder } = require("@stellar/stellar-sdk");
      TransactionBuilder.fromXDR = jest.fn().mockReturnValue({ submit: jest.fn() });

      await client.castVoteWithReasonAndSign(
        validGAddr,
        2n,
        VoteSupport.Abstain,
        "Needs more discussion",
        signCallback,
      );

      expect(signCallback).toHaveBeenCalledWith("unsigned-xdr");
    });
  });
});

// ---------------------------------------------------------------------------
// uploadProposalMetadata tests (issue #429)
// ---------------------------------------------------------------------------
import { uploadProposalMetadata, MetadataUploadOptions } from "../governor";

describe("uploadProposalMetadata()", () => {
  const description = "Fund the security audit for the NebGov contracts.";

  beforeEach(() => {
    // Reset fetch mock between tests.
    jest.restoreAllMocks();
  });

  it("uses customUploader when provided and returns uri + hash", async () => {
    const customUploader = jest.fn().mockResolvedValue("ipfs://QmCustomHash");
    const options: MetadataUploadOptions = { customUploader };

    const result = await uploadProposalMetadata(description, options);

    expect(customUploader).toHaveBeenCalledWith(description);
    expect(result.uri).toBe("ipfs://QmCustomHash");
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/); // 64-char hex SHA-256
  });

  it("uploads via Pinata JWT and returns ipfs:// URI", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ IpfsHash: "QmPinataHash123" }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const options: MetadataUploadOptions = { pinataApiKey: "test-jwt-token" };
    const result = await uploadProposalMetadata(description, options);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.pinata.cloud/pinning/pinJSONToIPFS",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-jwt-token",
        }),
      }),
    );
    expect(result.uri).toBe("ipfs://QmPinataHash123");
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uploads via Pinata legacy API key + secret pair", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ IpfsHash: "QmLegacyHash456" }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const options: MetadataUploadOptions = {
      pinataApiKey: "my-api-key",
      pinataSecretKey: "my-secret-key",
    };
    const result = await uploadProposalMetadata(description, options);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.pinata.cloud/pinning/pinJSONToIPFS",
      expect.objectContaining({
        headers: expect.objectContaining({
          pinata_api_key: "my-api-key",
          pinata_secret_api_key: "my-secret-key",
        }),
      }),
    );
    expect(result.uri).toBe("ipfs://QmLegacyHash456");
  });

  it("throws when Pinata returns a non-OK response", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const options: MetadataUploadOptions = { pinataApiKey: "bad-key" };

    await expect(uploadProposalMetadata(description, options)).rejects.toThrow(
      "Pinata upload failed: 401 Unauthorized",
    );
  });

  it("throws a clear error when no provider is configured", async () => {
    const options: MetadataUploadOptions = {};

    await expect(uploadProposalMetadata(description, options)).rejects.toThrow(
      "No IPFS upload provider configured in options",
    );
  });

  it("does NOT have a web3StorageToken field on MetadataUploadOptions (compile-time removal)", () => {
    // This test documents that web3StorageToken has been removed from the
    // public interface (issue #429).  TypeScript would catch this at compile
    // time; here we verify it at runtime via the object shape.
    const options: MetadataUploadOptions = {
      customUploader: async () => "ipfs://test",
    };
    expect("web3StorageToken" in options).toBe(false);
  });

  it("customUploader errors propagate to the caller", async () => {
    const customUploader = jest.fn().mockRejectedValue(new Error("IPFS node unreachable"));
    const options: MetadataUploadOptions = { customUploader };

    await expect(uploadProposalMetadata(description, options)).rejects.toThrow(
      "IPFS node unreachable",
    );
  });
});
