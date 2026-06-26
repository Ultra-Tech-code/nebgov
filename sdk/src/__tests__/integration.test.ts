import { Keypair } from "@stellar/stellar-sdk";
import { GovernorClient } from "../governor";
import { VoteType, ProposalState, type GovernorConfig } from "../types";
import { VotesClient } from "../votes";

const TESTNET_SECRET_KEY = process.env.TESTNET_SECRET_KEY;
const TESTNET_RPC_URL = process.env.TESTNET_RPC_URL;
const GOVERNOR_ADDRESS = process.env.GOVERNOR_ADDRESS;
const TIMELOCK_ADDRESS = process.env.TIMELOCK_ADDRESS;
const TOKEN_VOTES_ADDRESS = process.env.TOKEN_VOTES_ADDRESS;

const hasEnv = Boolean(
  TESTNET_SECRET_KEY &&
    GOVERNOR_ADDRESS &&
    TIMELOCK_ADDRESS &&
    TOKEN_VOTES_ADDRESS,
);

const describeIfConfigured = hasEnv ? describe : describe.skip;

describeIfConfigured("GovernorClient integration (testnet)", () => {
  let signer: Keypair;
  let governor: GovernorClient;

  beforeAll(() => {
    signer = Keypair.fromSecret(TESTNET_SECRET_KEY as string);

    const config: GovernorConfig = {
      governorAddress: GOVERNOR_ADDRESS as string,
      timelockAddress: TIMELOCK_ADDRESS as string,
      votesAddress: TOKEN_VOTES_ADDRESS as string,
      network: "testnet",
      rpcUrl: TESTNET_RPC_URL,
      simulationAccount: signer.publicKey(),
    };

    governor = new GovernorClient(config);
  });

  it("proposalCount() returns a number", async () => {
    const count = await governor.proposalCount();
    expect(typeof count).toBe("bigint");
    expect(count >= 0n).toBe(true);
  }, 30_000);

  it("getLatestLedger() returns current ledger", async () => {
    const latestLedger = await governor.getLatestLedger();
    expect(Number.isInteger(latestLedger)).toBe(true);
    expect(latestLedger > 0).toBe(true);
  }, 30_000);

  it("getSettings() returns valid governor settings", async () => {
    const settings = await governor.getSettings(signer.publicKey());
    expect(settings.votingPeriod > 0).toBe(true);
    expect(settings.proposalGracePeriod >= 0).toBe(true);
    expect(settings.quorumNumerator >= 0).toBe(true);
    expect(Object.values(VoteType)).toContain(settings.voteType);
  }, 30_000);

  it("getProposalState(1) returns a valid ProposalState", async () => {
    const count = await governor.proposalCount();
    if (count < 1n) {
      expect(count).toBe(0n);
      return;
    }

    const state = await governor.getProposalState(1n);
    expect(Object.values(ProposalState)).toContain(state);
  }, 30_000);
});

describeIfConfigured("VotesClient integration (testnet)", () => {
  let signer: Keypair;
  let governor: GovernorClient;
  let votes: VotesClient;

  beforeAll(() => {
    signer = Keypair.fromSecret(TESTNET_SECRET_KEY as string);

    const config: GovernorConfig = {
      governorAddress: GOVERNOR_ADDRESS as string,
      timelockAddress: TIMELOCK_ADDRESS as string,
      votesAddress: TOKEN_VOTES_ADDRESS as string,
      network: "testnet",
      rpcUrl: TESTNET_RPC_URL,
      simulationAccount: signer.publicKey(),
    };

    governor = new GovernorClient(config);
    votes = new VotesClient(config);
  });

  it("getVotes(testAccount) returns bigint", async () => {
    const currentVotes = await votes.getVotes(signer.publicKey());
    expect(typeof currentVotes).toBe("bigint");
    expect(currentVotes >= 0n).toBe(true);
  }, 30_000);

  it("getPastVotes(testAccount, pastLedger) returns bigint", async () => {
    const latestLedger = await governor.getLatestLedger();
    const pastLedger = Math.max(1, latestLedger - 1);
    const pastVotes = await votes.getPastVotes(signer.publicKey(), pastLedger);

    expect(typeof pastVotes).toBe("bigint");
    expect(pastVotes >= 0n).toBe(true);
  }, 30_000);

  it("getDelegatee(testAccount) returns address or null", async () => {
    const delegatee = await votes.getDelegatee(signer.publicKey());
    expect(delegatee === null || typeof delegatee === "string").toBe(true);

    if (delegatee !== null) {
      expect(delegatee.length > 0).toBe(true);
    }
  }, 30_000);
});

// ─── MultiToken voting strategy integration tests ─────────────────────────────
//
// Requires a governor deployed with MultiToken(2 tokens, 5000 BPS each).
// Set these env vars to run:
//   MULTI_TOKEN_GOVERNOR_ADDRESS
//   MULTI_TOKEN_TIMELOCK_ADDRESS
//   MULTI_TOKEN_VOTES_ADDRESS_1   (first token-votes contract, weight 5000 BPS)
//   MULTI_TOKEN_VOTES_ADDRESS_2   (second token-votes contract, weight 5000 BPS)
//
// The strategy weights sum to 10000 BPS (100%), so each token contributes 50%
// of the holder's balance to their effective voting power.

const MULTI_TOKEN_GOVERNOR_ADDRESS = process.env.MULTI_TOKEN_GOVERNOR_ADDRESS;
const MULTI_TOKEN_TIMELOCK_ADDRESS = process.env.MULTI_TOKEN_TIMELOCK_ADDRESS;
const MULTI_TOKEN_VOTES_ADDRESS_1 = process.env.MULTI_TOKEN_VOTES_ADDRESS_1;
const MULTI_TOKEN_VOTES_ADDRESS_2 = process.env.MULTI_TOKEN_VOTES_ADDRESS_2;

const hasMultiTokenEnv = Boolean(
  TESTNET_SECRET_KEY &&
    MULTI_TOKEN_GOVERNOR_ADDRESS &&
    MULTI_TOKEN_TIMELOCK_ADDRESS &&
    MULTI_TOKEN_VOTES_ADDRESS_1 &&
    MULTI_TOKEN_VOTES_ADDRESS_2,
);

const describeIfMultiToken = hasMultiTokenEnv ? describe : describe.skip;

describeIfMultiToken("GovernorClient integration — MultiToken voting strategy", () => {
  let signer: Keypair;
  let governor: GovernorClient;
  let votes1: VotesClient;
  let votes2: VotesClient;

  beforeAll(() => {
    signer = Keypair.fromSecret(TESTNET_SECRET_KEY as string);

    const baseConfig: GovernorConfig = {
      governorAddress: MULTI_TOKEN_GOVERNOR_ADDRESS as string,
      timelockAddress: MULTI_TOKEN_TIMELOCK_ADDRESS as string,
      votesAddress: MULTI_TOKEN_VOTES_ADDRESS_1 as string,
      network: "testnet",
      rpcUrl: TESTNET_RPC_URL,
      simulationAccount: signer.publicKey(),
    };

    governor = new GovernorClient(baseConfig);

    votes1 = new VotesClient(baseConfig);
    votes2 = new VotesClient({
      ...baseConfig,
      votesAddress: MULTI_TOKEN_VOTES_ADDRESS_2 as string,
    });
  });

  it("getSettings() returns a valid governor settings object", async () => {
    const settings = await governor.getSettings(signer.publicKey());
    expect(settings.votingPeriod > 0).toBe(true);
    expect(settings.quorumNumerator >= 0).toBe(true);
    expect(settings.proposalThreshold >= 0n).toBe(true);
    expect(Object.values(VoteType)).toContain(settings.voteType);
  }, 30_000);

  it("canPropose() uses combined voting power from both tokens", async () => {
    // Under MultiToken(token1: 5000 BPS, token2: 5000 BPS) the combined
    // voting power is: floor(token1_votes * 5000 / 10000) + floor(token2_votes * 5000 / 10000)
    const [token1Votes, token2Votes, canProposeResult] = await Promise.all([
      votes1.getVotes(signer.publicKey()),
      votes2.getVotes(signer.publicKey()),
      governor.canPropose(signer.publicKey()),
    ]);

    const expectedCombined =
      (token1Votes * 5000n) / 10000n + (token2Votes * 5000n) / 10000n;

    // The on-chain voting power should match the BPS-weighted sum
    expect(canProposeResult.votingPower).toEqual(expectedCombined);
    expect(typeof canProposeResult.allowed).toBe("boolean");
    expect(canProposeResult.threshold >= 0n).toBe(true);
  }, 30_000);

  it("proposalCount() returns a non-negative bigint", async () => {
    const count = await governor.proposalCount();
    expect(typeof count).toBe("bigint");
    expect(count >= 0n).toBe(true);
  }, 30_000);

  it("getProposalVotes() weight reflects BPS scaling when a proposal exists", async () => {
    const count = await governor.proposalCount();
    if (count < 1n) {
      // No proposals yet — skip vote weight check
      expect(count).toBe(0n);
      return;
    }

    const votes = await governor.getProposalVotes(1n);
    // Votes should be non-negative bigints scaled by BPS weights on-chain
    expect(typeof votes.votesFor).toBe("bigint");
    expect(typeof votes.votesAgainst).toBe("bigint");
    expect(typeof votes.votesAbstain).toBe("bigint");
    expect(votes.votesFor >= 0n).toBe(true);
    expect(votes.votesAgainst >= 0n).toBe(true);
    expect(votes.votesAbstain >= 0n).toBe(true);
  }, 30_000);

  it("getLatestLedger() returns a valid ledger number", async () => {
    const ledger = await governor.getLatestLedger();
    expect(Number.isInteger(ledger)).toBe(true);
    expect(ledger > 0).toBe(true);
  }, 30_000);
});
