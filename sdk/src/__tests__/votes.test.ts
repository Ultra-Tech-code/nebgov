// Define mocks with 'mock' prefix and use 'var' for hoisting support
var mockScValToNative = jest.fn();
var mockNativeToScVal = jest.fn();
var mockSimulate = jest.fn();
var mockGetAccount = jest.fn();
var mockPrepareTransaction = jest.fn();
var mockSendTransaction = jest.fn();
var mockIsSimulationError = jest.fn();
var mockGetLatestLedger = jest.fn();
var mockGetEvents = jest.fn();

import { VotesClient } from "../votes";
import { VotesError, VotesErrorCode } from "../errors";

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
        getLatestLedger: mockGetLatestLedger,
        getEvents: mockGetEvents,
      })),
      Api: {
        isSimulationError: mockIsSimulationError,
      },
    },
    Contract: jest.fn().mockImplementation((addr) => ({
      call: jest.fn().mockReturnValue({}),
      address: () => addr,
      contractId: () => addr,
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
  };
});

import { xdr, Account, Keypair } from "@stellar/stellar-sdk";

describe("VotesClient", () => {
  let client: VotesClient;
  const validGAddr = "GBFUUXATVOGXGD4KS3I423QFZSPE4ZFOQ3TCJVWFUYSIPULXIRVRE2DT";
  const validCAddr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const mockKeypair = Keypair.random();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAccount.mockResolvedValue(new Account(validGAddr, "1"));
    mockIsSimulationError.mockReturnValue(false);
    mockNativeToScVal.mockReturnValue({} as xdr.ScVal);
    mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
    mockGetEvents.mockResolvedValue({ events: [] });

    client = new VotesClient({
      governorAddress: validCAddr,
      timelockAddress: validCAddr,
      votesAddress: validCAddr,
      network: "testnet",
    });
  });

  describe("delegate()", () => {
    const delegateeAddr = "GBTESTDELEGATEEADDRESSEXAMPLEFORUNITTESTSTESTING";

    beforeEach(() => {
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "delegate123",
      });
    });

    it("successfully delegates voting power", async () => {
      await client.delegate(mockKeypair, delegateeAddr);

      expect(mockSendTransaction).toHaveBeenCalled();
      expect(mockPrepareTransaction).toHaveBeenCalled();
    });

    it("successfully self-delegates", async () => {
      await client.delegate(mockKeypair, mockKeypair.publicKey());

      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("throws VotesError when transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Invalid delegatee",
      });

      await expect(client.delegate(mockKeypair, delegateeAddr)).rejects.toThrow(
        VotesError
      );

      try {
        await client.delegate(mockKeypair, delegateeAddr);
      } catch (e) {
        expect(e).toBeInstanceOf(VotesError);
        expect((e as VotesError).code).toBe(VotesErrorCode.TransactionFailed);
      }
    });

    it("calls contract with correct parameters", async () => {
      await client.delegate(mockKeypair, delegateeAddr);

      expect(mockNativeToScVal).toHaveBeenCalledWith(mockKeypair.publicKey(), { type: "address" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(delegateeAddr, { type: "address" });
    });
  });

  describe("transferAndDelegate()", () => {
    const toAddr = "GBTESTRECIPIENTADDRESSEXAMPLEFORUNITTESTSTESTING";
    const delegateeAddr = "GBTESTDELEGATEEADDRESSEXAMPLEFORUNITTESTSTESTING";
    const amount = 250n;

    beforeEach(() => {
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "transferAndDelegate123",
      });
    });

    it("submits atomic transfer+delegate transaction", async () => {
      await client.transferAndDelegate(mockKeypair, toAddr, amount, delegateeAddr);

      expect(mockPrepareTransaction).toHaveBeenCalled();
      expect(mockSendTransaction).toHaveBeenCalled();
      expect(mockNativeToScVal).toHaveBeenCalledWith(mockKeypair.publicKey(), {
        type: "address",
      });
      expect(mockNativeToScVal).toHaveBeenCalledWith(toAddr, {
        type: "address",
      });
      expect(mockNativeToScVal).toHaveBeenCalledWith(amount, { type: "i128" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(delegateeAddr, {
        type: "address",
      });
    });

    it("throws VotesError on failed submission", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "insufficient balance",
      });

      await expect(
        client.transferAndDelegate(mockKeypair, toAddr, amount, delegateeAddr),
      ).rejects.toThrow(VotesError);
    });
  });

  describe("getVotes()", () => {
    const accountAddr = "GBTESTACCOUNTADDRESSEXAMPLEFORUNITTESTSTESTING";

    it("returns current voting power", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(1000);

      const votes = await client.getVotes(accountAddr);

      expect(votes).toBe(1000n);
    });

    it("returns 0n when account has no voting power", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(0);

      const votes = await client.getVotes(accountAddr);

      expect(votes).toBe(0n);
    });

    it("returns 0n when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Account not found",
      });

      const votes = await client.getVotes(accountAddr);

      expect(votes).toBe(0n);
    });

    it("returns 0n when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      const votes = await client.getVotes(accountAddr);

      expect(votes).toBe(0n);
    });

    it("handles large voting power values", async () => {
      const scv = {} as xdr.ScVal;
      const largeValue = 999999999999n;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(largeValue);

      const votes = await client.getVotes(accountAddr);

      expect(votes).toBe(largeValue);
    });
  });

  describe("getPastVotes()", () => {
    const accountAddr = "GBTESTACCOUNTADDRESSEXAMPLEFORUNITTESTSTESTING";
    const ledgerSeq = 12345;

    it("returns historical voting power", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(500);

      const votes = await client.getPastVotes(accountAddr, ledgerSeq);

      expect(votes).toBe(500n);
    });

    it("returns 0n when account had no voting power at ledger", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(0);

      const votes = await client.getPastVotes(accountAddr, ledgerSeq);

      expect(votes).toBe(0n);
    });

    it("returns 0n when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Ledger too old",
      });

      const votes = await client.getPastVotes(accountAddr, ledgerSeq);

      expect(votes).toBe(0n);
    });

    it("returns 0n when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      const votes = await client.getPastVotes(accountAddr, ledgerSeq);

      expect(votes).toBe(0n);
    });

    it("calls contract with correct ledger parameter", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(100);

      await client.getPastVotes(accountAddr, ledgerSeq);

      expect(mockNativeToScVal).toHaveBeenCalledWith(accountAddr, { type: "address" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(ledgerSeq, { type: "u32" });
    });
  });

  describe("getDelegatee()", () => {
    const accountAddr = "GBTESTACCOUNTADDRESSEXAMPLEFORUNITTESTSTESTING";
    const delegateeAddr = "GBTESTDELEGATEEADDRESSEXAMPLEFORUNITTESTSTESTING";

    it("returns current delegatee address", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(delegateeAddr);

      const delegatee = await client.getDelegatee(accountAddr);

      expect(delegatee).toBe(delegateeAddr);
    });

    it("returns null when account has no delegatee", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(null);

      const delegatee = await client.getDelegatee(accountAddr);

      expect(delegatee).toBeNull();
    });

    it("returns null when simulation fails", async () => {
      mockIsSimulationError.mockReturnValue(true);
      mockSimulate.mockResolvedValue({
        error: "Account not found",
      });

      const delegatee = await client.getDelegatee(accountAddr);

      expect(delegatee).toBeNull();
    });

    it("returns null when no return value", async () => {
      mockSimulate.mockResolvedValue({
        result: {},
      });

      const delegatee = await client.getDelegatee(accountAddr);

      expect(delegatee).toBeNull();
    });

    it("handles self-delegation", async () => {
      const scv = {} as xdr.ScVal;
      mockSimulate.mockResolvedValue({
        result: { retval: scv },
      });
      mockScValToNative.mockReturnValue(accountAddr);

      const delegatee = await client.getDelegatee(accountAddr);

      expect(delegatee).toBe(accountAddr);
    });
  });

  // ─── Analytics ────────────────────────────────────────────────────────────

  /**
   * Helper to set up mock events for del_chsh event scanning.
   *
   * scValToNative is called in strict order per event:
   *   1. topic[1]  → delegator address (string)
   *   2. value     → [previousDelegate | null, newDelegatee] (tuple)
   *
   * Use mockReturnValueOnce for each call after invoking this helper to
   * append getVotes / getTotalSupply return values in execution order.
   */
  function setupDelegationEvents(
    events: Array<{
      delegator: string;
      previousDelegate: string | null;
      newDelegatee: string;
      ledger: number;
    }>
  ) {
    mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
    mockGetEvents
      .mockResolvedValueOnce({
        events: events.map((e) => ({
          ledger: e.ledger,
          topic: [{}, {}],
          value: {},
        })),
      })
      .mockResolvedValue({ events: [] });

    // Queue scValToNative return values for event decoding phase
    for (const e of events) {
      mockScValToNative
        .mockReturnValueOnce(e.delegator)                                   // topic[1]
        .mockReturnValueOnce([e.previousDelegate, e.newDelegatee]);        // value
    }
  }

  describe("getTopDelegates()", () => {
    it("returns top N delegates sorted by voting power", async () => {
      const delegatorA = "GDELEGATORA";
      const delegatorB = "GDELEGATORB";
      const delegatorC = "GDELEGATORC";
      const delegateX = "GDELEGATEX";
      const delegateY = "GDELEGATEY";

      setupDelegationEvents([
        { delegator: delegatorA, previousDelegate: null, newDelegatee: delegateX, ledger: 99000 },
        { delegator: delegatorB, previousDelegate: null, newDelegatee: delegateX, ledger: 99001 },
        { delegator: delegatorC, previousDelegate: null, newDelegatee: delegateY, ledger: 99002 },
      ]);

      // getVotes(delegateX) = 200, getVotes(delegateY) = 50
      mockSimulate
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ result: { retval: {} } });
      mockScValToNative
        .mockReturnValueOnce(200n)
        .mockReturnValueOnce(50n);

      const top = await client.getTopDelegates(2, 99000);

      expect(top).toHaveLength(2);
      expect(top[0].address).toBe(delegateX);
      expect(top[0].votingPower).toBe(200n);
      expect(top[0].delegatorCount).toBe(2);
      expect(top[1].address).toBe(delegateY);
      expect(top[1].votingPower).toBe(50n);
      expect(top[1].delegatorCount).toBe(1);
    });

    it("returns empty array when no delegation events exist", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
      mockGetEvents.mockResolvedValue({ events: [] });

      const top = await client.getTopDelegates(10, 99000);

      expect(top).toEqual([]);
    });

    it("respects the limit parameter", async () => {
      setupDelegationEvents([
        { delegator: "GDA", previousDelegate: null, newDelegatee: "GDELEGATEX", ledger: 99000 },
        { delegator: "GDB", previousDelegate: null, newDelegatee: "GDELEGATEY", ledger: 99001 },
        { delegator: "GDC", previousDelegate: null, newDelegatee: "GDELEGATEZ", ledger: 99002 },
      ]);

      mockSimulate
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ result: { retval: {} } });
      mockScValToNative
        .mockReturnValueOnce(300n)
        .mockReturnValueOnce(200n)
        .mockReturnValueOnce(100n);

      const top = await client.getTopDelegates(1, 99000);

      expect(top).toHaveLength(1);
      expect(top[0].votingPower).toBe(300n);
    });

    it("throws VotesError(EventScanFailed) when event scanning fails", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
      mockGetEvents.mockRejectedValue(new Error("RPC unavailable"));

      await expect(client.getTopDelegates(10, 99000)).rejects.toThrow(VotesError);

      try {
        await client.getTopDelegates(10, 99000);
      } catch (e) {
        expect((e as VotesError).code).toBe(VotesErrorCode.EventScanFailed);
      }
    });
  });

  describe("getDelegators()", () => {
    it("returns delegators for a given delegate address", async () => {
      const delegateX = "GDELEGATEX";
      const delegatorA = "GDELEGATORA";
      const delegatorB = "GDELEGATORB";

      setupDelegationEvents([
        { delegator: delegatorA, previousDelegate: null, newDelegatee: delegateX, ledger: 99000 },
        { delegator: delegatorB, previousDelegate: null, newDelegatee: delegateX, ledger: 99001 },
        { delegator: "GDELEGATORC", previousDelegate: null, newDelegatee: "GDELEGATEY", ledger: 99002 },
      ]);

      // getVotes for delegatorA and delegatorB
      mockSimulate
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ result: { retval: {} } });
      mockScValToNative
        .mockReturnValueOnce(150n)
        .mockReturnValueOnce(75n);

      const delegators = await client.getDelegators(delegateX, 99000);

      expect(delegators).toHaveLength(2);
      expect(delegators.map((d) => d.delegator)).toContain(delegatorA);
      expect(delegators.map((d) => d.delegator)).toContain(delegatorB);
      // sorted descending by power
      expect(delegators[0].power).toBeGreaterThanOrEqual(delegators[1].power);
    });

    it("returns empty array when no one delegates to the address", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
      mockGetEvents.mockResolvedValue({ events: [] });

      const delegators = await client.getDelegators("GDELEGATEX", 99000);

      expect(delegators).toEqual([]);
    });

    it("reflects re-delegation (only the most recent delegation counts)", async () => {
      const delegateX = "GDELEGATEX";
      const delegateY = "GDELEGATEY";
      const delegatorA = "GDELEGATORA";

      mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
      mockGetEvents
        .mockResolvedValueOnce({
          events: [
            { ledger: 99000, topic: [{}, {}], value: {} },
            { ledger: 99001, topic: [{}, {}], value: {} },
          ],
        })
        .mockResolvedValue({ events: [] });

      // Event 0: delegatorA → delegateX
      // Event 1: delegatorA → delegateY (re-delegation)
      mockScValToNative
        .mockReturnValueOnce(delegatorA)
        .mockReturnValueOnce([null, delegateX])
        .mockReturnValueOnce(delegatorA)
        .mockReturnValueOnce([delegateX, delegateY]);

      // getDelegators(delegateX) should be empty — delegatorA moved to Y
      const delegatorsX = await client.getDelegators(delegateX, 99000);
      expect(delegatorsX).toEqual([]);
    });

    it("throws VotesError(EventScanFailed) when event scanning fails", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
      mockGetEvents.mockRejectedValue(new Error("network error"));

      await expect(client.getDelegators("GDELEGATEX", 99000)).rejects.toThrow(
        VotesError
      );
    });
  });

  describe("getVotingPowerDistribution()", () => {
    it("returns zero stats when no delegation events exist", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
      mockGetEvents.mockResolvedValue({ events: [] });

      // getTotalSupply simulation
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue(1_000_000n);

      const dist = await client.getVotingPowerDistribution(99000);

      expect(dist.totalDelegated).toBe(0n);
      expect(dist.delegationRate).toBe(0);
      expect(dist.giniCoefficient).toBe(0);
    });

    it("computes delegation rate correctly", async () => {
      const delegateX = "GDELEGATEX";

      setupDelegationEvents([
        { delegator: "GDA", previousDelegate: null, newDelegatee: delegateX, ledger: 99000 },
      ]);

      // Promise.all runs getTotalSupply and buildDelegationMap concurrently.
      // getTotalSupply: one simulate call + scValToNative(retval)
      // getVotes(delegateX): one simulate call + scValToNative(retval)
      mockSimulate
        .mockResolvedValueOnce({ result: { retval: {} } }) // getTotalSupply
        .mockResolvedValueOnce({ result: { retval: {} } }); // getVotes(delegateX)
      mockScValToNative
        .mockReturnValueOnce(1_000_000n)   // getTotalSupply result
        .mockReturnValueOnce(500_000n);    // getVotes(delegateX) result

      const dist = await client.getVotingPowerDistribution(99000);

      expect(dist.totalSupply).toBe(1_000_000n);
      expect(dist.totalDelegated).toBe(500_000n);
      expect(dist.delegationRate).toBeCloseTo(0.5);
    });

    it("returns giniCoefficient=0 for a single delegate", async () => {
      const delegateX = "GDELEGATEX";

      setupDelegationEvents([
        { delegator: "GDA", previousDelegate: null, newDelegatee: delegateX, ledger: 99000 },
      ]);

      mockSimulate
        .mockResolvedValueOnce({ result: { retval: {} } })
        .mockResolvedValueOnce({ result: { retval: {} } });
      mockScValToNative
        .mockReturnValueOnce(1_000_000n)
        .mockReturnValueOnce(100n);

      const dist = await client.getVotingPowerDistribution(99000);

      expect(dist.giniCoefficient).toBe(0);
    });

    it("throws VotesError(EventScanFailed) when event scanning fails", async () => {
      mockGetLatestLedger.mockResolvedValue({ sequence: 100000 });
      mockGetEvents.mockRejectedValue(new Error("timeout"));

      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue(0n);

      await expect(
        client.getVotingPowerDistribution(99000)
      ).rejects.toThrow(VotesError);
    });
  });

  describe("getTopDelegatesByAddresses() (legacy address-list API)", () => {
    it("returns sorted delegates with percentOfSupply", async () => {
      const addr1 = "GDELEGATEA";
      const addr2 = "GDELEGATEB";

      // getTotalSupply
      mockSimulate
        .mockResolvedValueOnce({ result: { retval: {} } }) // total supply
        .mockResolvedValueOnce({ result: { retval: {} } }) // getVotes addr1
        .mockResolvedValueOnce({ result: { retval: {} } }); // getVotes addr2

      let cIdx = 0;
      const responses = [1_000n, 400n, 200n];
      mockScValToNative.mockImplementation(() => responses[cIdx++]);

      const top = await client.getTopDelegatesByAddresses([addr1, addr2], 10);

      expect(top).toHaveLength(2);
      expect(top[0].address).toBe(addr1);
      expect(top[0].votes).toBe(400n);
      expect(top[1].address).toBe(addr2);
    });

    it("returns empty array when total supply is 0", async () => {
      mockSimulate.mockResolvedValue({ result: { retval: {} } });
      mockScValToNative.mockReturnValue(0n);

      const top = await client.getTopDelegatesByAddresses(["GDELEGATEA"], 10);

      expect(top).toEqual([]);
    });
  });

  describe("delegateBySig()", () => {
    const ownerAddr = "GDELEGATORA";
    const delegateeAddr = "GDELEGATEX";
    const nonce = 1n;
    const expiry = 9999999999n;
    const signature = Buffer.from("fake-signature-32-bytes-long!!", "utf8");

    beforeEach(() => {
      const mockTx = { sign: jest.fn() };
      mockPrepareTransaction.mockResolvedValue(mockTx);
      mockSendTransaction.mockResolvedValue({
        status: "PENDING",
        hash: "delegate-by-sig-123",
      });
      mockGetTransaction.mockResolvedValue({
        status: "SUCCESS",
        returnValue: xdr.ScVal.scvVoid(),
      });
    });

    it("constructs delegation transaction with correct parameters", async () => {
      mockGetAccount.mockResolvedValue(new Account(validGAddr, "2"));

      await client.delegateBySig(ownerAddr, delegateeAddr, nonce, expiry, signature);

      expect(mockNativeToScVal).toHaveBeenCalledWith(ownerAddr, { type: "address" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(delegateeAddr, { type: "address" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(nonce, { type: "u64" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(expiry, { type: "u64" });
      expect(mockNativeToScVal).toHaveBeenCalledWith(signature, { type: "bytes" });
      expect(mockPrepareTransaction).toHaveBeenCalled();
      expect(mockSendTransaction).toHaveBeenCalled();
    });

    it("throws VotesError when transaction fails", async () => {
      mockSendTransaction.mockResolvedValue({
        status: "ERROR",
        error: "Invalid signature",
      });

      await expect(
        client.delegateBySig(ownerAddr, delegateeAddr, nonce, expiry, signature)
      ).rejects.toThrow(VotesError);
    });

    it("uses contract address as the source account for the transaction", async () => {
      mockGetAccount.mockResolvedValue(new Account(validGAddr, "2"));

      await client.delegateBySig(ownerAddr, delegateeAddr, nonce, expiry, signature);

      expect(mockGetAccount).toHaveBeenCalledWith(validCAddr);
    });
  });

  describe("signDelegation()", () => {
    const delegateeAddr = "GDELEGATEX";
    const nonce = 1n;
    const expiry = 9999999999n;

    it("includes contract address as domain separator", () => {
      const sig = client.signDelegation(mockKeypair, delegateeAddr, nonce, expiry);

      expect(sig).toBeInstanceOf(Buffer);
      expect(sig.length).toBe(64);
    });

    it("produces deterministic output for same inputs", () => {
      const sig1 = client.signDelegation(mockKeypair, delegateeAddr, nonce, expiry);
      const sig2 = client.signDelegation(mockKeypair, delegateeAddr, nonce, expiry);

      expect(sig1).toEqual(sig2);
    });

    it("produces different signatures for different delegatees", () => {
      const sig1 = client.signDelegation(mockKeypair, "GDELEGATEY", nonce, expiry);
      const sig2 = client.signDelegation(mockKeypair, delegateeAddr, nonce, expiry);

      expect(sig1).not.toEqual(sig2);
    });
  });
});
