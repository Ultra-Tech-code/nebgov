/**
 * NebGov SDK — core types
 */

/** Stellar network identifier. */
export type Network = "mainnet" | "testnet" | "futurenet";

/** On-chain lifecycle state of a governance proposal. */
export enum ProposalState {
  /** Created but voting has not started yet. */
  Pending = "Pending",
  /** Voting is currently open. */
  Active = "Active",
  /** Voting closed; quorum or majority not reached. */
  Defeated = "Defeated",
  /** Voting closed; quorum and majority reached — awaiting queue or execution. */
  Succeeded = "Succeeded",
  /** Queued in the timelock, awaiting the execution delay. */
  Queued = "Queued",
  /** Successfully executed on-chain. */
  Executed = "Executed",
  /** Cancelled by the proposer or guardian. */
  Cancelled = "Cancelled",
  /** Queued but not executed before the execution deadline. */
  Expired = "Expired",
}

/** Thrown when an unrecognised on-chain proposal-state variant is encountered. */
export class UnknownProposalStateError extends Error {
  constructor(variant: string) {
    super(`Unknown proposal state: ${variant}`);
    this.name = "UnknownProposalStateError";
  }
}

/** How a voter casts their ballot. */
export enum VoteSupport {
  /** Vote against the proposal. */
  Against = 0,
  /** Vote in favour of the proposal. */
  For = 1,
  /** Formally participate without choosing a side. */
  Abstain = 2,
}

/** Voting mechanism used by the governor. */
export enum VoteType {
  /** One token = one vote. */
  Simple = "Simple",
  /** Extended voting with configurable time-weight. */
  Extended = "Extended",
  /** Square-root of token balance used as vote weight. */
  Quadratic = "Quadratic",
}

/** Full on-chain representation of a governance proposal. */
export interface Proposal {
  /** Unique numeric identifier assigned at creation. */
  id: bigint;
  /** Stellar address that submitted the proposal. */
  proposer: string;
  /** Human-readable summary stored on-chain. */
  description: string;
  /** Ledger sequence at which voting opens. */
  startLedger: number;
  /** Ledger sequence at which voting closes. */
  endLedger: number;
  /** Accumulated votes in favour. */
  votesFor: bigint;
  /** Accumulated votes against. */
  votesAgainst: bigint;
  /** Accumulated abstain votes. */
  votesAbstain: bigint;
  /** Whether the proposal has been executed. */
  executed: boolean;
  /** Whether the proposal was cancelled. */
  cancelled: boolean;
}

/** Input parameters for creating a single-action proposal. */
export interface ProposalInput {
  /** Human-readable proposal summary. */
  description: string;
  /** Target contract address for the on-chain action. */
  target: string;
  /** Function name to invoke on the target. */
  fnName: string;
  /** ABI-encoded call arguments. */
  calldata: Buffer | Uint8Array;
}

/** Aggregated vote tallies for a proposal. */
export interface ProposalVotes {
  /** Total tokens cast in favour. */
  votesFor: bigint;
  /** Total tokens cast against. */
  votesAgainst: bigint;
  /** Total tokens cast as abstain. */
  votesAbstain: bigint;
}

export interface GovernorConfig {
  /** Contract address of the governor */
  governorAddress: string;
  /** Contract address of the timelock */
  timelockAddress: string;
  /** Contract address of the token-votes contract */
  votesAddress: string;
  /** Stellar network to connect to */
  network: Network;
  /** RPC URL override (optional — defaults to public horizon) */
  rpcUrl?: string;
  /** Optional funded classic account used for read-only simulation calls. */
  simulationAccount?: string;
  /** Indexer base URL for off-chain queries (e.g. getVotingHistory) */
  indexerUrl?: string;
  /** Maximum number of retry attempts for RPC calls (default: 3) */
  maxAttempts?: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000) */
  baseDelayMs?: number;
}

export interface TimelockOperation {
  id: string; // hex-encoded operation hash
  target: string;
  readyAt: bigint;
  expiresAt: bigint;
  executed: boolean;
  cancelled: boolean;
}

export interface TimelockInfo {
  queueLedger: number;
  vetoWindowEndLedger: number;
  executableAtLedger: number;
  executionDeadlineLedger: number;
}

export interface TreasuryTx {
  id: bigint;
  proposer: string;
  target: string;
  approvals: number;
  executed: boolean;
  cancelled: boolean;
}

export interface ProposalAction {
  target: string;
  function: string;
  args: any[];
}

export interface ProposalSimulationResult {
  success: boolean;
  computeUnits?: number;
  stateChanges?: any[];
  error?: string;
}

export interface GovernorEntry {
  id: bigint;
  governor: string;
  timelock: string;
  token: string;
  deployer: string;
}

export interface DeploySettings {
  votingDelay: number;
  votingPeriod: number;
  quorumNumerator: number;
  proposalThreshold: bigint;
  timelockDelay: bigint;
  guardian: string;
  voteType: VoteType;
  proposalGracePeriod: number;
}

export interface FactoryConfig {
  factoryAddress: string;
  network: Network;
  rpcUrl?: string;
  /** Maximum number of retry attempts for RPC calls (default: 3) */
  maxAttempts?: number;
  /** Base delay in milliseconds for exponential backoff (default: 1000) */
  baseDelayMs?: number;
}

export interface GuardianActivityEntry {
  proposalId: bigint;
  canceller: string;
  ledger: number;
}

export interface GovernorSettings {
  votingDelay: number;
  votingPeriod: number;
  quorumNumerator: number;
  proposalThreshold: bigint;
  guardian: string;
  voteType: VoteType;
  proposalGracePeriod: number;
  useDynamicQuorum?: boolean;
  reflectorOracle?: string | null;
  minQuorumUsd?: bigint;
  maxCalldataSize?: number;
  proposalCooldown?: number;
  maxProposalsPerPeriod?: number;
  proposalPeriodDuration?: number;
}

export interface GovernorSettingsValidationLimits {
  maxVotingDelay?: number;
  minVotingPeriod?: number;
}

export interface ExecutionGasEstimate {
  proposalId: bigint;
  actionCount: number;
  calldataBytes: number;
  estimatedCpuInsns: bigint;
  estimatedMemBytes: bigint;
  estimatedFeeStroops: bigint;
  rpcCpuInsns?: bigint;
  rpcMemBytes?: bigint;
}

export interface DelegateInfo {
  address: string;
  votes: bigint;
  percentOfSupply: number;
}

export interface VotesSettings {
  checkpointRetentionPeriod: number;
  timeWeightEnabled: boolean;
  timeWeightScale: number;
}

export interface DelegatorRecord {
  balance: bigint;
  startLedger: number;
}

export interface VoteGasEstimate {
  ok: boolean;
  cpuInsns?: string;
  memBytes?: string;
  estimatedFeeStroops?: string;
  error?: string;
}

// ─── Votes Analytics Types ────────────────────────────────────────────────────

/** A delegate's summary as returned by {@link VotesClient.getTopDelegates}. */
export interface TopDelegate {
  /** Stellar strkey address of the delegate */
  address: string;
  /** Current voting power held by this delegate (effective) */
  votingPower: bigint;
  /** Base token votes (ignoring time-weight) */
  baseVotes: bigint;
  /** Number of accounts currently delegating to this address */
  delegatorCount: number;
}

/** Delegation health statistics as returned by {@link VotesClient.getVotingPowerDistribution}. */
export interface VotingPowerDistribution {
  /** Total voting power currently delegated across all accounts */
  totalDelegated: bigint;
  /** Total token supply from the votes contract */
  totalSupply: bigint;
  /**
   * Fraction of total supply that is actively delegated, expressed as a
   * value between 0 and 1 (e.g. 0.42 means 42% of tokens are delegated).
   */
  delegationRate: number;
  /**
   * Gini coefficient of voting power concentration (0 = perfectly equal,
   * 1 = fully concentrated in one account).
   */
  giniCoefficient: number;
}

/** A single delegator's record as returned by {@link VotesClient.getDelegators}. */
export interface DelegatorInfo {
  /** Stellar strkey address of the delegator */
  delegator: string;
  /** Voting power this delegator contributes to the delegate */
  power: bigint;
}

// ─── Treasury Types ───────────────────────────────────────────────────────────

/** Configuration for {@link TreasuryClient}. */
export interface TreasuryConfig {
  /** Contract address of the treasury */
  treasuryAddress: string;
  /** Stellar network to connect to */
  network: Network;
  /** RPC URL override (optional — defaults to public horizon) */
  rpcUrl?: string;
  /** Optional funded classic account used for read-only simulation calls. */
  simulationAccount?: string;
  /** Indexer base URL for off-chain queries (e.g. getBatchTransferHistory) */
  indexerUrl?: string;
  /** Maximum retry attempts for failed operations (default: 3) */
  maxAttempts?: number;
  /** Base delay between retries in milliseconds (default: 1000) */
  baseDelayMs?: number;
}

/** A single recipient in a batch transfer operation. */
export interface BatchTransferRecipient {
  /** Stellar strkey address of the recipient */
  address: string;
  /** Amount of tokens to transfer (in the token's base unit) */
  amount: bigint;
}

export interface SpendingCap {
  token: string;
  maxAmount: bigint;
  periodLedgers: number;
}

/** A treasury batch transfer event as returned by the indexer. */
export interface BatchTransferEvent {
  /** SHA-256 operation hash (hex-encoded) */
  opHash: string;
  /** Strkey address of the token that was transferred */
  token: string;
  /** Number of recipients in the batch */
  recipientCount: number;
  /** Total amount transferred across all recipients */
  totalAmount: bigint;
  /** Ledger sequence number at which the transfer was executed */
  ledger: number;
}

/** Result of checking whether an address can propose. */
export interface CanProposeResult {
  /** Whether the address is allowed to propose */
  allowed: boolean;
  /** Reason code: "ok", "threshold", "cooldown", "ratelimit", "paused" */
  reason: string;
  /** Ledger when cooldown ends (if in cooldown) */
  cooldownEndsAt?: number;
  /** Number of proposals made in current period */
  proposalsThisPeriod: number;
  /** Maximum proposals allowed per period */
  maxPerPeriod: number;
  /** Current voting power of the proposer */
  votingPower: bigint;
  /** Proposal threshold required */
  threshold: bigint;
}

/** A single vote in a voter's history. */
export interface VotingHistoryEntry {
  /** Proposal ID that was voted on */
  proposalId: bigint;
  /** Vote direction (For, Against, or Abstain) */
  support: VoteSupport;
  /** Weight of the vote */
  weight: bigint;
  /** Optional reason provided with the vote */
  reason?: string;
  /** Ledger sequence when the vote was cast */
  ledger: number;
}
