#![no_std]
#![allow(clippy::too_many_arguments)]
// Prevent future introduction of dead match patterns in this security-critical
// state machine (issue #439).
#![deny(unreachable_patterns)]

mod events;

use soroban_sdk::xdr::FromXdr;
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    contract, contractclient, contracterror, contractimpl, contracttype, symbol_short, Address,
    Bytes, BytesN, Env, IntoVal, String, Symbol, Val, Vec,
};

/// Governor error codes.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GovernorError {
    UnauthorizedCancel = 1,
    InvalidSupport = 2,
    ProposalExpired = 3,
    CalldataTooLarge = 4,
    InvalidCalldata = 5,
    ProposalRateLimited = 6,
    ContractPaused = 7,
    UnauthorizedPause = 8,
    InvalidVectorLengths = 9,
    NoTargets = 10,
    ProposalThresholdNotMet = 11,
    AlreadyVoted = 12,
    ZeroVotingPower = 13,
    ProposalNotSucceeded = 14,
    ProposalNotQueued = 15,
    ProposalAlreadyExecuted = 16,
    MissingOpIds = 17,
    UnauthorizedGuardian = 18,
    VetoWindowClosed = 19,
    ProposalNotFound = 20,
    TimelockNotSet = 21,
    GuardianNotSet = 22,
    TooManyTokens = 23,
    EmptyMetadataUri = 24,
    VotesTokenNotSet = 25,
    PauserNotSet = 26,
    ArithmeticOverflow = 27,
    VotePeriodTooShort = 28,
    ExecutionWindowZero = 29,
    TooManyCalldataEntries = 30,
}

/// Cross-contract interface for the Timelock contract.
///
/// The governor uses this to schedule proposals after they succeed and to
/// trigger execution once the mandatory delay has elapsed.
#[contractclient(name = "TimelockClient")]
pub trait TimelockTrait {
    #[allow(clippy::too_many_arguments)]
    fn schedule(
        env: Env,
        caller: Address,
        target: Address,
        data: Bytes,
        fn_name: Symbol,
        delay: u64,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes;
    #[allow(clippy::too_many_arguments)]
    fn schedule_batch(
        env: Env,
        caller: Address,
        targets: Vec<Address>,
        datas: Vec<Bytes>,
        fn_names: Vec<Symbol>,
        delay: u64,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes;
    fn execute(env: Env, caller: Address, op_id: Bytes);
    fn execute_batch(env: Env, caller: Address, batch_op_id: Bytes);
    fn cancel(env: Env, caller: Address, op_id: Bytes);
    fn min_delay(env: Env) -> u64;
    fn execution_window(env: Env) -> u64;
    fn is_done(env: Env, op_id: Bytes) -> bool;
    fn is_batch_done(env: Env, batch_op_id: Bytes) -> bool;
}

/// Cross-contract interface for the TokenVotes contract.
///
/// The governor uses this to check voting power when creating proposals and
/// casting votes, and to query snapshot-based total supply for quorum.
#[contractclient(name = "VotesClient")]
pub trait VotesTrait {
    /// Get current voting power of an account.
    fn get_votes(env: Env, account: Address) -> i128;
    /// Get voting power at a past ledger sequence (snapshot).
    fn get_past_votes(env: Env, account: Address, ledger: u32) -> i128;
    /// Get the total token supply at a past ledger sequence (snapshot).
    fn get_past_total_supply(env: Env, ledger: u32) -> i128;
}

/// Cross-contract interface for the Reflector oracle.
///
/// Used for dynamic quorum calculations based on token USD price.
#[contractclient(name = "ReflectorOracleClient")]
pub trait ReflectorOracleTrait {
    fn lastprice(env: Env, asset: Address) -> Option<i128>;
}

/// A token address paired with its BPS weight (10000 = 1x).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct WeightedToken {
    pub token: Address,
    pub weight_bps: u32,
}

/// Voting strategy for the governor.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum VotingStrategy {
    /// Single token (default, backward compatible). Uses the VotesToken stored at init.
    Single,
    /// Weighted sum from up to 5 tokens. weight = sum(get_past_votes(t) * bps / 10000).
    MultiToken(Vec<WeightedToken>),
}

/// Proposal lifecycle states.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ProposalState {
    Pending,
    Active,
    Defeated,
    Succeeded,
    Queued,
    Executed,
    Cancelled,
    Expired,
}

/// A governance proposal.
#[contracttype]
#[derive(Clone)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub description: String,
    /// SHA-256 hash of the off-chain proposal description for content integrity verification.
    pub description_hash: BytesN<32>,
    /// URI pointing to the full proposal description content (supports ipfs:// and https://).
    pub metadata_uri: String,
    /// Contract addresses that will be invoked when the proposal executes.
    pub targets: Vec<Address>,
    /// Function names invoked on each target. Each element corresponds to the
    /// target at the same index.
    pub fn_names: Vec<Symbol>,
    /// Calldata bytes for each target. Each element corresponds to the target
    /// at the same index.
    pub calldatas: Vec<Bytes>,
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub votes_for: i128,
    pub votes_against: i128,
    pub votes_abstain: i128,
    pub executed: bool,
    pub cancelled: bool,
    pub queued: bool,
    /// Timelock operation ids created during queue().
    ///
    /// One op-id per (target, fn_name, calldata) tuple.
    pub op_ids: Vec<Bytes>,
}

/// Placeholder type for future storage migration data.
///
/// When a contract upgrade introduces a breaking change to the on-chain
/// storage layout, add the required migration values as fields here and
/// implement the migration logic inside [`GovernorContract::migrate`].
///
/// `new_version` is a monotonically increasing counter that callers must
/// supply so the migration can be applied exactly once per upgrade.
#[contracttype]
pub struct MigrateData {
    /// Monotonically increasing schema version written by this migration.
    /// Extend this struct with additional fields as the storage layout evolves.
    pub new_version: u32,
}

/// Governor configuration settings that can be updated via governance proposal.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct GovernorSettings {
    pub voting_delay: u32,
    pub voting_period: u32,
    pub quorum_numerator: u32,
    pub proposal_threshold: i128,
    pub guardian: Address,
    pub vote_type: VoteType,
    pub proposal_grace_period: u32,
    /// When true, quorum is the max of the static quorum and a USD-denominated floor.
    pub use_dynamic_quorum: bool,
    /// Address of the Reflector oracle used for dynamic quorum pricing.
    pub reflector_oracle: Option<Address>,
    /// Minimum quorum expressed in USD (6-decimal format, matching Reflector prices).
    pub min_quorum_usd: i128,
    /// Maximum calldata size per action in bytes.
    pub max_calldata_size: u32,
    /// Minimum ledgers between proposals from the same address (cooldown period).
    pub proposal_cooldown: u32,
    /// Maximum proposals per period (period measured in ledgers).
    pub max_proposals_per_period: u32,
    /// Period duration in ledgers for proposal rate limiting.
    pub proposal_period_duration: u32,
}

/// Estimated resource cost for executing a proposal.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ExecutionGasEstimate {
    pub proposal_id: u64,
    pub action_count: u32,
    pub calldata_bytes: u32,
    pub estimated_cpu_insns: u64,
    pub estimated_mem_bytes: u64,
    pub estimated_fee_stroops: i128,
}

/// Result of checking whether an address can propose.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CanProposeResult {
    pub allowed: bool,
    pub reason: Symbol,
    pub cooldown_ends_at: Option<u32>,
    pub proposals_this_period: u32,
    pub max_per_period: u32,
    pub voting_power: i128,
    pub threshold: i128,
}

/// Vote support options.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum VoteSupport {
    Against,
    For,
    Abstain,
}

/// Voting receipt for a specific voter on a proposal.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct VotingReceipt {
    pub has_voted: bool,
    pub support: VoteSupport,
    pub weight: i128,
    pub reason: String,
}

/// Vote type configurations.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum VoteType {
    Simple,    // For / Against only
    Extended,  // For / Against / Abstain (current)
    Quadratic, // weight = sqrt(tokens)
}

/// Storage keys.
#[contracttype]
pub enum DataKey {
    Proposal(u64),
    ProposalCount,
    VotingDelay,
    VotingPeriod,
    QuorumNumerator,
    ProposalThreshold,
    Timelock,
    VotesToken,
    Admin,
    Guardian,
    VoteType,
    ProposalGracePeriod,
    HasVoted(u64, Address),
    VoteReason(u64, Address),
    VoteReceipt(u64, Address),
    /// The timelock op-id (Bytes) for a proposal after queue() is called.
    QueuedOpId(u64),
    /// The ledger sequence number when a proposal was queued (for veto window tracking).
    QueueTime(u64),
    ProposalExpiredEmitted(u64),
    CurrentWasmHash,
    /// Active voting strategy (Single or MultiToken).
    VotingStrategy,
    /// Whether dynamic quorum is enabled.
    UseDynamicQuorum,
    /// Address of the Reflector oracle for dynamic quorum.
    ReflectorOracle,
    /// Minimum quorum floor in USD (6-decimal format).
    MinQuorumUsd,
    /// Address authorized to pause/unpause the contract.
    Pauser,
    /// Whether the contract is currently paused.
    IsPaused,
    /// Last proposal ledger for an address (for cooldown).
    LastProposalLedger(Address),
    /// Proposal count for an address in current period.
    ProposalsInPeriod(Address, u32),
    /// Maximum calldata size per action in bytes.
    MaxCalldataSize,
    /// Minimum ledgers between proposals from the same address (cooldown period).
    ProposalCooldown,
    /// Maximum proposals per period (period measured in ledgers).
    MaxProposalsPerPeriod,
    /// Period duration in ledgers for proposal rate limiting.
    ProposalPeriodDuration,
}

#[contract]
pub struct GovernorContract;

#[contractimpl]
impl GovernorContract {
    fn must_get_proposal(env: &Env, proposal_id: u64) -> Proposal {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .unwrap_or_else(|| env.panic_with_error(GovernorError::ProposalNotFound))
    }

    /// Extend the TTL of a proposal storage entry to cover its full lifecycle.
    ///
    /// Soroban persistent storage entries have a TTL that must be explicitly extended.
    /// This function ensures a proposal's storage entry will not expire before the
    /// proposal can be executed. The TTL is extended to cover:
    /// - Voting period (end_ledger - current_ledger)
    /// - Grace period (proposal_grace_period)
    /// - Timelock delay and execution window
    /// - Additional buffer for safety
    fn extend_proposal_ttl(env: &Env, proposal_id: u64, proposal: &Proposal) {
        let current = env.ledger().sequence();
        
        // Get configuration from storage
        let grace_period: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalGracePeriod)
            .unwrap_or(120_960);
        
        // Get timelock delay and execution window
        let timelock_addr: Option<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Timelock);
        
        let timelock_delay_ledgers: u32 = if let Some(addr) = timelock_addr {
            let timelock = TimelockClient::new(env, &addr);
            let delay_seconds = timelock.min_delay();
            let execution_window_seconds = timelock.execution_window();
            // Convert seconds to ledgers (assuming ~5 second blocks)
            ((delay_seconds + execution_window_seconds) / 5) as u32
        } else {
            1000 // conservative default
        };
        
        // Calculate remaining ledgers until proposal end
        let ledgers_until_end = proposal.end_ledger.saturating_sub(current);
        
        // Total TTL: remaining voting period + grace period + timelock operations + buffer
        // The buffer ensures we don't expire even if timing is tight
        let ttl_ledgers = ledgers_until_end
            .saturating_add(grace_period)
            .saturating_add(timelock_delay_ledgers)
            .saturating_add(1000); // 1000 ledger safety buffer (~83 minutes)
        
        // Extend the TTL for the proposal storage entry
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Proposal(proposal_id), ttl_ledgers, ttl_ledgers);
    }

    fn decode_calldata_args(env: &Env, data: &Bytes) -> Vec<Val> {
        if data.is_empty() {
            return Vec::new(env);
        }

        if let Ok(args) = Vec::<Val>::from_xdr(env, data) {
            return args;
        }

        Vec::new(env)
    }

    fn emit_proposal_expired_if_needed(env: &Env, proposal: &Proposal) {
        let expired_emitted: bool = env
            .storage()
            .persistent()
            .get(&DataKey::ProposalExpiredEmitted(proposal.id))
            .unwrap_or(false);

        if expired_emitted || proposal.cancelled || proposal.executed || proposal.queued {
            return;
        }

        let current = env.ledger().sequence();
        let quorum = Self::quorum(env.clone(), proposal.id);
        let quorum_met = proposal.votes_for >= quorum;
        let for_wins = proposal.votes_for > proposal.votes_against;

        if current > proposal.end_ledger && !(quorum_met && for_wins) {
            events::emit_proposal_expired(env, proposal.id, proposal.end_ledger);
            env.storage()
                .persistent()
                .set(&DataKey::ProposalExpiredEmitted(proposal.id), &true);
        }
    }

    /// Initialize the governor with configuration.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        env: Env,
        admin: Address,
        votes_token: Address,
        timelock: Address,
        voting_delay: u32,
        voting_period: u32,
        quorum_numerator: u32,
        proposal_threshold: i128,
        guardian: Address,
        vote_type: VoteType,
        proposal_grace_period: u32,
    ) {
        admin.require_auth();
        if voting_period == 0 {
            env.panic_with_error(GovernorError::VotePeriodTooShort);
        }
        let timelock_client = TimelockClient::new(&env, &timelock);
        let execution_window = timelock_client.execution_window();
        if execution_window == 0 {
            env.panic_with_error(GovernorError::ExecutionWindowZero);
        }
        // timelock_delay + execution_window must not overflow u64
        let _ = timelock_client
            .min_delay()
            .checked_add(execution_window)
            .unwrap_or_else(|| env.panic_with_error(GovernorError::ArithmeticOverflow));

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::VotesToken, &votes_token);
        env.storage().instance().set(&DataKey::Timelock, &timelock);
        env.storage()
            .instance()
            .set(&DataKey::VotingDelay, &voting_delay);
        env.storage()
            .instance()
            .set(&DataKey::VotingPeriod, &voting_period);
        env.storage()
            .instance()
            .set(&DataKey::QuorumNumerator, &quorum_numerator);
        env.storage()
            .instance()
            .set(&DataKey::ProposalThreshold, &proposal_threshold);
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        env.storage().instance().set(&DataKey::VoteType, &vote_type);
        env.storage()
            .instance()
            .set(&DataKey::ProposalGracePeriod, &proposal_grace_period);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
        env.storage().instance().set(
            &DataKey::CurrentWasmHash,
            &BytesN::from_array(&env, &[0u8; 32]),
        );
        env.storage()
            .instance()
            .set(&DataKey::VotingStrategy, &VotingStrategy::Single);
        env.storage()
            .instance()
            .set(&DataKey::UseDynamicQuorum, &false);
        // Initialize new security settings with defaults
        env.storage()
            .instance()
            .set(&DataKey::MaxCalldataSize, &10_000u32); // 10KB max calldata
        env.storage()
            .instance()
            .set(&DataKey::ProposalCooldown, &100u32); // ~10 min cooldown
        env.storage()
            .instance()
            .set(&DataKey::MaxProposalsPerPeriod, &5u32); // 5 proposals per period
        env.storage()
            .instance()
            .set(&DataKey::ProposalPeriodDuration, &10_000u32); // ~24 hour period
                                                                // Initialize pause state (not paused by default)
        env.storage().instance().set(&DataKey::IsPaused, &false);
        // Set admin as initial pauser
        env.storage().instance().set(&DataKey::Pauser, &admin);
    }

    /// Create a new governance proposal.
    ///
    /// `targets` and `calldatas` specify the on-chain actions to execute if
    /// the proposal passes. Each element in `targets` is a contract address,
    /// and the corresponding element in `calldatas` contains the encoded
    /// function call data.
    ///
    /// Before creating the proposal, this function verifies that the proposer
    /// has sufficient voting power to meet the `proposal_threshold`.
    #[allow(clippy::too_many_arguments)]
    pub fn propose(
        env: Env,
        proposer: Address,
        description: String,
        description_hash: BytesN<32>,
        metadata_uri: String,
        targets: Vec<Address>,
        fn_names: Vec<Symbol>,
        calldatas: Vec<Bytes>,
    ) -> u64 {
        proposer.require_auth();

        // Validate all vectors have the same length
        if !(targets.len() == fn_names.len() && targets.len() == calldatas.len()) {
            env.panic_with_error(GovernorError::InvalidVectorLengths);
        }
        if targets.is_empty() {
            env.panic_with_error(GovernorError::NoTargets);
        }

        // Validate calldata size limits (Issue #186)
        let max_calldata_size: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxCalldataSize)
            .unwrap_or(10_000);
        for i in 0..calldatas.len() {
            let calldata = calldatas.get(i).unwrap();
            if calldata.len() > max_calldata_size {
                env.panic_with_error(GovernorError::CalldataTooLarge);
            }
        }

        // Validate calldata count (Issue #447)
        //
        // MaxCalldataSize limits the byte size of each individual calldata entry,
        // but does not bound the *number* of entries.  A proposal with thousands
        // of tiny entries would pass the size check yet exhaust the Soroban
        // compute budget when execute() iterates and dispatches every entry.
        //
        // 10 is a conservative upper bound that covers all realistic batch
        // governance proposals while preventing compute-exhaustion attacks.
        const MAX_CALLDATA_COUNT: u32 = 10;
        if calldatas.len() > MAX_CALLDATA_COUNT {
            env.panic_with_error(GovernorError::TooManyCalldataEntries);
        }

        // Rate limiting checks (Issue #188)
        let current_ledger = env.ledger().sequence();

        // Check cooldown period
        let cooldown: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCooldown)
            .unwrap_or(100);
        let last_proposal_ledger: Option<u32> = env
            .storage()
            .persistent()
            .get(&DataKey::LastProposalLedger(proposer.clone()));
        if let Some(last) = last_proposal_ledger {
            if current_ledger < last + cooldown {
                env.panic_with_error(GovernorError::ProposalRateLimited);
            }
        }

        // Check max proposals per period
        let period_duration: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalPeriodDuration)
            .unwrap_or(10_000);
        let max_proposals: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxProposalsPerPeriod)
            .unwrap_or(5);

        let current_period = current_ledger / period_duration;
        let proposals_in_period: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::ProposalsInPeriod(
                proposer.clone(),
                current_period,
            ))
            .unwrap_or(0);

        if proposals_in_period >= max_proposals {
            env.panic_with_error(GovernorError::ProposalRateLimited);
        }

        // Get the voting power of the proposer (strategy-aware)
        let proposer_votes = Self::compute_proposer_votes(&env, &proposer);

        // Enforce proposal threshold
        let threshold: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalThreshold)
            .unwrap_or(0);

        if proposer_votes < threshold {
            env.panic_with_error(GovernorError::ProposalThresholdNotMet);
        }

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let proposal_id = count + 1;

        let voting_delay: u32 = env
            .storage()
            .instance()
            .get(&DataKey::VotingDelay)
            .unwrap_or(100);
        let voting_period: u32 = env
            .storage()
            .instance()
            .get(&DataKey::VotingPeriod)
            .unwrap_or(1000);

        let current = env.ledger().sequence();
        let proposal = Proposal {
            id: proposal_id,
            proposer: proposer.clone(),
            description: description.clone(),
            description_hash: description_hash.clone(),
            metadata_uri: metadata_uri.clone(),
            targets: targets.clone(),
            fn_names: fn_names.clone(),
            calldatas: calldatas.clone(),
            start_ledger: current + voting_delay,
            end_ledger: current + voting_delay + voting_period,
            votes_for: 0,
            votes_against: 0,
            votes_abstain: 0,
            executed: false,
            cancelled: false,
            queued: false,
            op_ids: Vec::new(&env),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        // Extend TTL to cover full proposal lifecycle
        Self::extend_proposal_ttl(&env, proposal_id, &proposal);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &proposal_id);

        // Update rate limiting storage
        env.storage()
            .persistent()
            .set(&DataKey::LastProposalLedger(proposer.clone()), &current);
        env.storage().persistent().set(
            &DataKey::ProposalsInPeriod(proposer.clone(), current_period),
            &(proposals_in_period + 1),
        );

        // Emit ProposalCreated event with all proposal fields
        env.events().publish(
            (symbol_short!("prop_crtd"), proposer.clone()),
            (
                proposal_id,
                description,
                description_hash,
                metadata_uri,
                targets,
                fn_names,
                calldatas,
                current + voting_delay,
                current + voting_delay + voting_period,
            ),
        );

        events::emit_proposal_created(&env, &proposal);

        proposal_id
    }

    /// Apply vote type weighting to raw voting power.
    fn apply_vote_type(vote_type: VoteType, raw_weight: i128) -> i128 {
        match vote_type {
            VoteType::Simple | VoteType::Extended => raw_weight,
            VoteType::Quadratic => {
                // Integer square root for quadratic voting
                let raw_u128 = raw_weight as u128;
                if raw_u128 == 0 {
                    return 0;
                }
                // Simple integer square root implementation
                let mut x = raw_u128;
                let mut y = x.div_ceil(2);
                while y < x {
                    x = y;
                    y = (x + raw_u128 / x) / 2;
                }
                x as i128
            }
        }
    }

    /// Validate vote support against configured vote type.
    fn validate_vote_support(env: &Env, support: &VoteSupport) -> Result<(), GovernorError> {
        let vote_type: VoteType = env
            .storage()
            .instance()
            .get(&DataKey::VoteType)
            .unwrap_or(VoteType::Extended);

        match vote_type {
            VoteType::Simple => {
                if matches!(support, VoteSupport::Abstain) {
                    Err(GovernorError::InvalidSupport)
                } else {
                    Ok(())
                }
            }
            VoteType::Extended | VoteType::Quadratic => Ok(()),
        }
    }

    /// Cast a vote on an active proposal.
    ///
    /// Reads the voter's snapshot voting power at `proposal.start_ledger` from
    /// the token-votes contract via a cross-contract call.
    pub fn cast_vote(env: Env, voter: Address, proposal_id: u64, support: VoteSupport) {
        voter.require_auth();

        // Validate vote support against configured vote type
        Self::validate_vote_support(&env, &support).unwrap_or_else(|e| env.panic_with_error(e));

        let voted: bool = env
            .storage()
            .persistent()
            .get(&DataKey::HasVoted(proposal_id, voter.clone()))
            .unwrap_or(false);
        if voted {
            env.panic_with_error(GovernorError::AlreadyVoted);
        }

        let mut proposal = Self::must_get_proposal(&env, proposal_id);

        // Look up the voter's snapshot voting power at the proposal's start ledger
        // using the active voting strategy (single token or multi-token weighted).
        let raw_weight: i128 = Self::compute_votes(&env, &voter, &proposal.start_ledger);

        if raw_weight < 0 {
            env.panic_with_error(GovernorError::ZeroVotingPower);
        }

        // Apply vote type weighting
        let vote_type: VoteType = env
            .storage()
            .instance()
            .get(&DataKey::VoteType)
            .unwrap_or(VoteType::Extended);
        let weight = Self::apply_vote_type(vote_type, raw_weight);

        match support {
            VoteSupport::For => proposal.votes_for += weight,
            VoteSupport::Against => proposal.votes_against += weight,
            VoteSupport::Abstain => proposal.votes_abstain += weight,
        }

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        // Extend TTL to cover full proposal lifecycle
        Self::extend_proposal_ttl(&env, proposal_id, &proposal);
        env.storage()
            .persistent()
            .set(&DataKey::HasVoted(proposal_id, voter.clone()), &true);

        // Store voting receipt
        let receipt = VotingReceipt {
            has_voted: true,
            support: support.clone(),
            weight,
            reason: String::from_str(&env, ""),
        };
        env.storage()
            .persistent()
            .set(&DataKey::VoteReceipt(proposal_id, voter.clone()), &receipt);

        // Emit VoteCast event including the weighted vote power.
        events::emit_vote_cast(&env, &voter, proposal_id, &support, weight);
    }

    /// Cast a vote with an on-chain reason string.
    pub fn cast_vote_with_reason(
        env: Env,
        voter: Address,
        proposal_id: u64,
        support: VoteSupport,
        reason: String,
    ) {
        voter.require_auth();

        // Validate vote support against configured vote type
        Self::validate_vote_support(&env, &support).unwrap_or_else(|e| env.panic_with_error(e));

        let voted: bool = env
            .storage()
            .persistent()
            .get(&DataKey::HasVoted(proposal_id, voter.clone()))
            .unwrap_or(false);
        if voted {
            env.panic_with_error(GovernorError::AlreadyVoted);
        }

        let mut proposal = Self::must_get_proposal(&env, proposal_id);

        // Look up the voter's snapshot voting power at the proposal's start ledger
        let raw_weight: i128 = Self::compute_votes(&env, &voter, &proposal.start_ledger);
        if raw_weight < 0 {
            env.panic_with_error(GovernorError::ZeroVotingPower);
        }

        // Apply vote type weighting
        let vote_type: VoteType = env
            .storage()
            .instance()
            .get(&DataKey::VoteType)
            .unwrap_or(VoteType::Extended);
        let weight = Self::apply_vote_type(vote_type, raw_weight);

        match support {
            VoteSupport::For => proposal.votes_for += weight,
            VoteSupport::Against => proposal.votes_against += weight,
            VoteSupport::Abstain => proposal.votes_abstain += weight,
        }

        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        // Extend TTL to cover full proposal lifecycle
        Self::extend_proposal_ttl(&env, proposal_id, &proposal);
        env.storage()
            .persistent()
            .set(&DataKey::HasVoted(proposal_id, voter.clone()), &true);

        // Store the reason in persistent storage
        env.storage()
            .persistent()
            .set(&DataKey::VoteReason(proposal_id, voter.clone()), &reason);

        // Store voting receipt with reason
        let receipt = VotingReceipt {
            has_voted: true,
            support: support.clone(),
            weight,
            reason: reason.clone(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::VoteReceipt(proposal_id, voter.clone()), &receipt);

        // Emit VoteCastWithReason event
        events::emit_vote_cast_with_reason(&env, &voter, proposal_id, &support, weight, reason);
    }

    /// Queue a succeeded proposal for execution via the timelock.
    ///
    /// Reads the timelock's configured `min_delay` and schedules the proposal's
    /// target invocation. The returned op-id is stored so `execute()` can
    /// reference it later.
    ///
    /// Schedules every action in the proposal via the Timelock contract.
    pub fn queue(env: Env, proposal_id: u64) {
        let proposal_state = Self::state(env.clone(), proposal_id);

        if proposal_state == ProposalState::Expired {
            env.panic_with_error(GovernorError::ProposalExpired);
        }

        if proposal_state != ProposalState::Succeeded {
            env.panic_with_error(GovernorError::ProposalNotSucceeded);
        }

        let mut proposal = Self::must_get_proposal(&env, proposal_id);

        // Independently re-verify quorum and threshold against the final vote
        // tally so that stale cached state cannot allow a failed proposal through.
        let required_quorum = Self::quorum(env.clone(), proposal_id);
        let quorum_met = proposal.votes_for + proposal.votes_abstain >= required_quorum;
        let for_wins = proposal.votes_for > proposal.votes_against;
        if !quorum_met || !for_wins {
            env.panic_with_error(GovernorError::ProposalNotSucceeded);
        }

        let timelock_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Timelock)
            .unwrap_or_else(|| env.panic_with_error(GovernorError::TimelockNotSet));
        let gov_addr = env.current_contract_address();
        let timelock = TimelockClient::new(&env, &timelock_addr);

        if proposal.targets.is_empty() {
            env.panic_with_error(GovernorError::NoTargets);
        }

        // Use the timelock's own minimum delay to guarantee the configured
        // execution window is respected.
        let delay = timelock.min_delay();

        let ready_at = env.ledger().timestamp() + delay;

        // Schedule proposal actions via the timelock.
        // Multi-action proposals use schedule_batch() — one batch_op_id for all
        // actions — which reduces storage costs and enables atomic execution.
        // Single-action proposals use the existing schedule() path.
        let mut op_ids: Vec<Bytes> = Vec::new(&env);
        let empty_bytes = Bytes::new(&env);

        if proposal.targets.len() > 1 {
            let batch_op_id = timelock.schedule_batch(
                &gov_addr,
                &proposal.targets,
                &proposal.calldatas,
                &proposal.fn_names,
                &delay,
                &empty_bytes,
                &empty_bytes,
            );
            op_ids.push_back(batch_op_id);
        } else {
            let target = proposal.targets.get(0).unwrap();
            let fn_name = proposal.fn_names.get(0).unwrap();
            let calldata = proposal.calldatas.get(0).unwrap();
            let op_id = timelock.schedule(
                &gov_addr,
                &target,
                &calldata,
                &fn_name,
                &delay,
                &empty_bytes,
                &empty_bytes,
            );
            op_ids.push_back(op_id);
        }

        proposal.op_ids = op_ids;
        proposal.queued = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        // Extend TTL to cover full proposal lifecycle
        Self::extend_proposal_ttl(&env, proposal_id, &proposal);

        // Store the queue time (current ledger sequence) for veto window tracking
        let queue_time = env.ledger().sequence();
        env.storage()
            .persistent()
            .set(&DataKey::QueueTime(proposal_id), &queue_time);

        let first_op_id = proposal.op_ids.get(0).unwrap();
        events::emit_proposal_queued(&env, proposal_id, &first_op_id, ready_at);
    }

    /// Execute a queued proposal.
    ///
    /// Delegates to the timelock to enforce the delay, which in turn invokes
    /// `proposal.fn_name()` on `proposal.target`.
    pub fn execute(env: Env, proposal_id: u64) {
        if Self::state(env.clone(), proposal_id) != ProposalState::Queued {
            env.panic_with_error(GovernorError::ProposalNotQueued);
        }

        let mut proposal = Self::must_get_proposal(&env, proposal_id);

        if proposal.executed {
            env.panic_with_error(GovernorError::ProposalAlreadyExecuted);
        }

        let timelock_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Timelock)
            .unwrap_or_else(|| env.panic_with_error(GovernorError::TimelockNotSet));
        let gov_addr = env.current_contract_address();

        // Execute all timelock operations scheduled by queue().
        if proposal.op_ids.is_empty() {
            env.panic_with_error(GovernorError::MissingOpIds);
        }

        let timelock = TimelockClient::new(&env, &timelock_addr);

        // Multi-action proposals were batch-scheduled: one batch_op_id covers all
        // actions.  Call execute_batch() for atomic all-or-nothing execution.
        // Single-action proposals use the existing execute() path.
        if proposal.targets.len() > 1 {
            let batch_op_id = proposal.op_ids.get(0).unwrap();

            let mut timelock_args: Vec<Val> = Vec::new(&env);
            timelock_args.push_back(gov_addr.clone().into_val(&env));
            timelock_args.push_back(batch_op_id.clone().into_val(&env));

            let mut sub_invocations = Vec::new(&env);
            for j in 0..proposal.targets.len() {
                let target = proposal.targets.get(j).unwrap();
                let fn_name = proposal.fn_names.get(j).unwrap();
                let calldata = proposal.calldatas.get(j).unwrap();
                let decoded_args = Self::decode_calldata_args(&env, &calldata);
                if !decoded_args.is_empty() {
                    let target_context = ContractContext {
                        contract: target,
                        fn_name,
                        args: decoded_args,
                    };
                    sub_invocations.push_back(InvokerContractAuthEntry::Contract(
                        SubContractInvocation {
                            context: target_context,
                            sub_invocations: Vec::new(&env),
                        },
                    ));
                }
            }

            let mut auth_entries = Vec::new(&env);
            auth_entries.push_back(InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: timelock_addr.clone(),
                    fn_name: Symbol::new(&env, "execute_batch"),
                    args: timelock_args,
                },
                sub_invocations,
            }));
            env.authorize_as_current_contract(auth_entries);

            timelock.execute_batch(&gov_addr, &batch_op_id);
        } else {
            let op_id = proposal.op_ids.get(0).unwrap();
            let target = proposal.targets.get(0).unwrap();
            let fn_name = proposal.fn_names.get(0).unwrap();
            let calldata = proposal.calldatas.get(0).unwrap();
            let decoded_args = Self::decode_calldata_args(&env, &calldata);

            let mut timelock_args: Vec<Val> = Vec::new(&env);
            timelock_args.push_back(gov_addr.clone().into_val(&env));
            timelock_args.push_back(op_id.clone().into_val(&env));

            let mut sub_invocations = Vec::new(&env);
            if !decoded_args.is_empty() {
                let target_context = ContractContext {
                    contract: target,
                    fn_name,
                    args: decoded_args,
                };
                sub_invocations.push_back(InvokerContractAuthEntry::Contract(
                    SubContractInvocation {
                        context: target_context,
                        sub_invocations: Vec::new(&env),
                    },
                ));
            }

            let mut auth_entries = Vec::new(&env);
            auth_entries.push_back(InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: timelock_addr.clone(),
                    fn_name: Symbol::new(&env, "execute"),
                    args: timelock_args,
                },
                sub_invocations,
            }));
            env.authorize_as_current_contract(auth_entries);

            timelock.execute(&gov_addr, &op_id);
        }

        proposal.executed = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        // Extend TTL to cover full proposal lifecycle
        Self::extend_proposal_ttl(&env, proposal_id, &proposal);

        events::emit_proposal_executed(&env, proposal_id, &gov_addr);
    }

    /// Execute multiple queued proposals in order.
    ///
    /// Performs a full queued-state preflight for every proposal before
    /// executing any of them, avoiding partial completion in malformed batches.
    pub fn execute_batch(env: Env, proposal_ids: Vec<u64>) {
        assert!(!proposal_ids.is_empty(), "empty batch");

        for i in 0..proposal_ids.len() {
            let proposal_id = proposal_ids.get(i).expect("proposal missing");
            assert!(
                Self::state(env.clone(), proposal_id) == ProposalState::Queued,
                "proposal not queued"
            );
        }

        for i in 0..proposal_ids.len() {
            let proposal_id = proposal_ids.get(i).expect("proposal missing");
            Self::execute(env.clone(), proposal_id);
        }

        env.events()
            .publish((symbol_short!("exbatch"),), proposal_ids);
    }

    /// Cancel a proposal. Only proposer or admin can cancel.
    /// TODO issue #7: enforce cancellation rules, emit event.
    pub fn cancel(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();

        let proposal = Self::must_get_proposal(&env, proposal_id);

        let state = Self::state(env.clone(), proposal_id);
        let guardian: Address = env
            .storage()
            .instance()
            .get(&DataKey::Guardian)
            .unwrap_or_else(|| env.panic_with_error(GovernorError::GuardianNotSet));

        let can_cancel = (caller == proposal.proposer && state == ProposalState::Pending)
            || (caller == guardian && state == ProposalState::Active);

        if !can_cancel {
            env.panic_with_error(GovernorError::UnauthorizedCancel);
        }

        let mut proposal = proposal;
        proposal.cancelled = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        // Extend TTL to cover full proposal lifecycle
        Self::extend_proposal_ttl(&env, proposal_id, &proposal);
        events::emit_proposal_cancelled(&env, proposal_id, &caller);
    }

    /// Cancel a proposal via governance vote.
    ///
    /// This function can only be called by the governor contract itself,
    /// which means it must be triggered as an action in a successful proposal.
    /// This allows the community to cancel other proposals through the standard
    /// voting process.
    ///
    /// If the target proposal is already queued, its associated timelock
    /// operations are also cancelled.
    pub fn cancel_by_governance(env: Env, proposal_id: u64) {
        // Only callable by the governor contract itself
        env.current_contract_address().require_auth();

        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        // Verify the proposal is not already executed or cancelled
        assert!(
            !proposal.executed && !proposal.cancelled,
            "proposal already executed or cancelled"
        );

        let mut proposal_mut = proposal;
        proposal_mut.cancelled = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal_mut);
        // Extend TTL to cover full proposal lifecycle
        Self::extend_proposal_ttl(&env, proposal_id, &proposal_mut);

        // If the proposal was queued, cancel its timelock operations
        if proposal_mut.queued {
            let timelock_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::Timelock)
                .expect("timelock not set");
            let timelock = TimelockClient::new(&env, &timelock_addr);
            let gov_addr = env.current_contract_address();

            for i in 0..proposal_mut.op_ids.len() {
                let op_id = proposal_mut.op_ids.get(i).unwrap();
                timelock.cancel(&gov_addr, &op_id);
            }
        }

        events::emit_proposal_cancelled(&env, proposal_id, &env.current_contract_address());
    }

    /// Cancel a queued proposal during the veto window.
    ///
    /// Only the guardian can cancel a queued proposal, and only within the veto
    /// window that expires at `queue_time + timelock_delay`. After the veto
    /// window closes, this function reverts.
    ///
    /// This cancellation also cancels all associated timelock operations via
    /// the timelock contract.
    pub fn cancel_queued(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();

        let proposal = Self::must_get_proposal(&env, proposal_id);

        // Verify the proposal is queued
        if !proposal.queued || proposal.cancelled {
            env.panic_with_error(GovernorError::ProposalNotQueued);
        }

        let guardian: Address = env
            .storage()
            .instance()
            .get(&DataKey::Guardian)
            .unwrap_or_else(|| env.panic_with_error(GovernorError::GuardianNotSet));

        // Only guardian can cancel queued proposals
        if caller != guardian {
            env.panic_with_error(GovernorError::UnauthorizedGuardian);
        }

        // Get the queue time for veto window check
        let queue_time: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::QueueTime(proposal_id))
            .unwrap_or_else(|| env.panic_with_error(GovernorError::ProposalNotQueued));

        // Get the timelock delay
        let timelock_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Timelock)
            .unwrap_or_else(|| env.panic_with_error(GovernorError::TimelockNotSet));
        let timelock = TimelockClient::new(&env, &timelock_addr);
        let delay = timelock.min_delay();

        // Check if we're still in the veto window
        let current_ledger = env.ledger().sequence();
        // For simplicity, use delay directly as ledger count (adjusting for typical Soroban block times)
        // The veto window should close after timelock_delay seconds
        // Conversion: assume timelock delay is in seconds and we need ledger conversion
        let veto_window_end_ledger = queue_time + ((delay / 10) as u32); // Roughly 1 ledger per 10 seconds

        if current_ledger >= veto_window_end_ledger {
            env.panic_with_error(GovernorError::VetoWindowClosed);
        }

        // Cancel the proposal
        let mut proposal_mut = proposal;
        proposal_mut.cancelled = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal_mut);
        // Extend TTL to cover full proposal lifecycle
        Self::extend_proposal_ttl(&env, proposal_id, &proposal_mut);

        // Cancel all timelock operations associated with this proposal
        let gov_addr = env.current_contract_address();
        for i in 0..proposal_mut.op_ids.len() {
            let op_id = proposal_mut.op_ids.get(i).unwrap();
            timelock.cancel(&gov_addr, &op_id);
        }

        // Emit ProposalCancelledFromQueue event (TODO: add helper for veto event)
        env.events().publish(
            (Symbol::new(&env, "ProposalCancelled"), caller.clone()),
            (proposal_id, queue_time, current_ledger),
        );
    }

    /// Get the current state of a proposal.
    ///
    /// After the voting period ends, the proposal is Succeeded when it has at
    /// least one For vote, more For votes than Against votes, and meets the
    /// quorum requirement (votes_for + votes_abstain >= quorum).
    pub fn state(env: Env, proposal_id: u64) -> ProposalState {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .unwrap_or_else(|| env.panic_with_error(GovernorError::ProposalNotFound));

        if proposal.cancelled {
            return ProposalState::Cancelled;
        }
        if proposal.executed {
            return ProposalState::Executed;
        }
        if proposal.queued {
            return ProposalState::Queued;
        }

        let current = env.ledger().sequence();
        if current < proposal.start_ledger {
            return ProposalState::Pending;
        }

        if current <= proposal.end_ledger {
            return ProposalState::Active;
        }

        Self::emit_proposal_expired_if_needed(&env, &proposal);

        // Voting ended.
        let quorum = Self::quorum(env.clone(), proposal_id);
        let quorum_met = proposal.votes_for + proposal.votes_abstain >= quorum;
        let for_wins = proposal.votes_for > proposal.votes_against;
        let against_wins_or_ties = proposal.votes_against >= proposal.votes_for;

        if quorum_met && for_wins {
            // Check if succeeded proposal has expired
            let grace_period: u32 = env
                .storage()
                .instance()
                .get(&DataKey::ProposalGracePeriod)
                .unwrap_or(120_960); // Default ~7 days
            let grace_end = proposal.end_ledger + grace_period;
            if current > grace_end {
                ProposalState::Expired
            } else {
                ProposalState::Succeeded
            }
        } else if !quorum_met || against_wins_or_ties {
            ProposalState::Defeated
        } else {
            // This branch is structurally unreachable: the outer condition
            // `!(quorum_met && for_wins)` means at least one of `!quorum_met`
            // or `against_wins_or_ties` is true, so the `else if` above always
            // matches first.  The `unreachable!()` here documents that intent
            // and will panic loudly if a future refactor accidentally makes
            // this path reachable (issue #439).
            unreachable!("state machine invariant violated: defeated branch must have been taken")
        }
    }

    /// Calculate the quorum required for a proposal based on the total supply
    /// at the proposal's start ledger.
    pub fn quorum(env: Env, proposal_id: u64) -> i128 {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .unwrap_or_else(|| env.panic_with_error(GovernorError::ProposalNotFound));

        let quorum_numerator: u32 = env
            .storage()
            .instance()
            .get(&DataKey::QuorumNumerator)
            .unwrap_or(0);

        // If quorum is configured as 0%, no need to query token supply from
        // the votes contract. This also keeps state()/queue() robust in
        // tests where the votes token might be a placeholder address.
        if quorum_numerator == 0 {
            return 0;
        }

        let strategy: VotingStrategy = env
            .storage()
            .instance()
            .get(&DataKey::VotingStrategy)
            .unwrap_or(VotingStrategy::Single);

        let supply = Self::compute_quorum_supply(&env, &proposal.start_ledger, &strategy);

        let static_quorum = supply
            .checked_mul(quorum_numerator as i128)
            .unwrap_or_else(|| env.panic_with_error(GovernorError::ArithmeticOverflow))
            / 100;

        let use_dynamic: bool = env
            .storage()
            .instance()
            .get(&DataKey::UseDynamicQuorum)
            .unwrap_or(false);
        if !use_dynamic {
            return static_quorum;
        }

        // Try to fetch token price from Reflector oracle.
        let oracle_opt: Option<Address> = env.storage().instance().get(&DataKey::ReflectorOracle);
        if let Some(oracle_addr) = oracle_opt {
            let votes_token_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::VotesToken)
                .unwrap_or_else(|| env.panic_with_error(GovernorError::VotesTokenNotSet));

            let min_quorum_usd: i128 = env
                .storage()
                .instance()
                .get(&DataKey::MinQuorumUsd)
                .unwrap_or(0);
            if min_quorum_usd > 0 {
                // Call oracle — fall back to static if it fails or returns None/zero.
                let oracle = ReflectorOracleClient::new(&env, &oracle_addr);
                let price_opt = oracle.try_lastprice(&votes_token_addr);
                if let Ok(Ok(Some(price))) = price_opt {
                    if price > 0 {
                        let usd_quorum = min_quorum_usd / price;
                        return static_quorum.max(usd_quorum);
                    }
                }
            }
        }
        static_quorum
    }

    /// Get the quorum required for a specific proposal.
    ///
    /// Returns the quorum calculated based on the total supply at the proposal's
    /// start ledger. If dynamic quorum is enabled, returns the maximum of the
    /// static quorum and the USD-denominated minimum quorum floor.
    pub fn get_quorum(env: Env, proposal_id: u64) -> i128 {
        Self::quorum(env, proposal_id)
    }

    /// Check if a proposal has reached quorum.
    ///
    /// Returns true if the sum of for and abstain votes meets or exceeds the
    /// required quorum for the proposal.
    pub fn is_quorum_reached(env: Env, proposal_id: u64) -> bool {
        let proposal = Self::must_get_proposal(&env, proposal_id);
        let required = Self::quorum(env, proposal_id);
        proposal.votes_for + proposal.votes_abstain >= required
    }

    /// Get vote counts for a proposal.
    pub fn proposal_votes(env: Env, proposal_id: u64) -> (i128, i128, i128) {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
            .unwrap_or_else(|| env.panic_with_error(GovernorError::ProposalNotFound));
        (
            proposal.votes_for,
            proposal.votes_against,
            proposal.votes_abstain,
        )
    }

    /// Get governor configuration.
    pub fn voting_delay(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::VotingDelay)
            .unwrap_or(100)
    }

    pub fn voting_period(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::VotingPeriod)
            .unwrap_or(1000)
    }

    pub fn proposal_threshold(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalThreshold)
            .unwrap_or(0)
    }

    pub fn quorum_numerator(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::QuorumNumerator)
            .unwrap_or(0)
    }

    pub fn get_settings(env: Env) -> GovernorSettings {
        GovernorSettings {
            voting_delay: env
                .storage()
                .instance()
                .get(&DataKey::VotingDelay)
                .unwrap_or(100),
            voting_period: env
                .storage()
                .instance()
                .get(&DataKey::VotingPeriod)
                .unwrap_or(1000),
            quorum_numerator: env
                .storage()
                .instance()
                .get(&DataKey::QuorumNumerator)
                .unwrap_or(0),
            proposal_threshold: env
                .storage()
                .instance()
                .get(&DataKey::ProposalThreshold)
                .unwrap_or(0),
            guardian: env
                .storage()
                .instance()
                .get(&DataKey::Guardian)
                .unwrap_or_else(|| env.panic_with_error(GovernorError::GuardianNotSet)),
            vote_type: env
                .storage()
                .instance()
                .get(&DataKey::VoteType)
                .unwrap_or(VoteType::Extended),
            proposal_grace_period: env
                .storage()
                .instance()
                .get(&DataKey::ProposalGracePeriod)
                .unwrap_or(120_960),
            use_dynamic_quorum: env
                .storage()
                .instance()
                .get(&DataKey::UseDynamicQuorum)
                .unwrap_or(false),
            reflector_oracle: env.storage().instance().get(&DataKey::ReflectorOracle),
            min_quorum_usd: env
                .storage()
                .instance()
                .get(&DataKey::MinQuorumUsd)
                .unwrap_or(0),
            max_calldata_size: env
                .storage()
                .instance()
                .get(&DataKey::MaxCalldataSize)
                .unwrap_or(10_000),
            proposal_cooldown: env
                .storage()
                .instance()
                .get(&DataKey::ProposalCooldown)
                .unwrap_or(100),
            max_proposals_per_period: env
                .storage()
                .instance()
                .get(&DataKey::MaxProposalsPerPeriod)
                .unwrap_or(5),
            proposal_period_duration: env
                .storage()
                .instance()
                .get(&DataKey::ProposalPeriodDuration)
                .unwrap_or(10_000),
        }
    }

    fn validate_settings(_env: &Env, new_settings: &GovernorSettings) {
        assert!(
            new_settings.voting_delay <= 1_209_600,
            "voting delay exceeds maximum"
        );
        assert!(
            new_settings.voting_period > 0,
            "voting period must be positive"
        );
        assert!(
            new_settings.quorum_numerator <= 100,
            "quorum numerator must be at most 100"
        );
        assert!(
            new_settings.proposal_threshold >= 0,
            "proposal threshold must be non-negative"
        );
        assert!(
            new_settings.max_calldata_size > 0,
            "max calldata size must be positive"
        );
        assert!(
            new_settings.max_proposals_per_period > 0,
            "max proposals per period must be positive"
        );
        assert!(
            new_settings.proposal_period_duration > 0,
            "proposal period duration must be positive"
        );
    }

    /// Update governor configuration parameters.
    ///
    /// Authorization is restricted to the governor's own contract address.
    /// This means the call must originate from an executed on-chain proposal.
    pub fn update_config(env: Env, new_settings: GovernorSettings) {
        env.current_contract_address().require_auth();
        Self::validate_settings(&env, &new_settings);

        let old_settings = Self::get_settings(env.clone());

        env.storage()
            .instance()
            .set(&DataKey::VotingDelay, &new_settings.voting_delay);
        env.storage()
            .instance()
            .set(&DataKey::VotingPeriod, &new_settings.voting_period);
        env.storage()
            .instance()
            .set(&DataKey::QuorumNumerator, &new_settings.quorum_numerator);
        env.storage().instance().set(
            &DataKey::ProposalThreshold,
            &new_settings.proposal_threshold,
        );
        env.storage()
            .instance()
            .set(&DataKey::Guardian, &new_settings.guardian);
        env.storage()
            .instance()
            .set(&DataKey::VoteType, &new_settings.vote_type);
        env.storage().instance().set(
            &DataKey::ProposalGracePeriod,
            &new_settings.proposal_grace_period,
        );
        env.storage()
            .instance()
            .set(&DataKey::UseDynamicQuorum, &new_settings.use_dynamic_quorum);
        env.storage()
            .instance()
            .set(&DataKey::MinQuorumUsd, &new_settings.min_quorum_usd);
        env.storage()
            .instance()
            .set(&DataKey::MaxCalldataSize, &new_settings.max_calldata_size);
        env.storage()
            .instance()
            .set(&DataKey::ProposalCooldown, &new_settings.proposal_cooldown);
        env.storage().instance().set(
            &DataKey::MaxProposalsPerPeriod,
            &new_settings.max_proposals_per_period,
        );
        env.storage().instance().set(
            &DataKey::ProposalPeriodDuration,
            &new_settings.proposal_period_duration,
        );
        match new_settings.reflector_oracle {
            Some(ref addr) => env
                .storage()
                .instance()
                .set(&DataKey::ReflectorOracle, addr),
            None => env.storage().instance().remove(&DataKey::ReflectorOracle),
        }

        events::emit_config_updated(&env, &old_settings, &new_settings);
    }

    /// Update the maximum calldata size per proposal action.
    ///
    /// Authorization is restricted to the governor's own contract address.
    pub fn update_max_calldata_size(env: Env, max_calldata_size: u32) {
        env.current_contract_address().require_auth();
        assert!(max_calldata_size > 0, "max calldata size must be positive");

        let old_settings = Self::get_settings(env.clone());
        env.storage()
            .instance()
            .set(&DataKey::MaxCalldataSize, &max_calldata_size);
        let new_settings = Self::get_settings(env.clone());

        events::emit_config_updated(&env, &old_settings, &new_settings);
    }

    /// Update the minimum ledgers between proposals from the same address.
    ///
    /// Authorization is restricted to the governor's own contract address.
    pub fn update_proposal_cooldown(env: Env, proposal_cooldown: u32) {
        env.current_contract_address().require_auth();

        let old_settings = Self::get_settings(env.clone());
        env.storage()
            .instance()
            .set(&DataKey::ProposalCooldown, &proposal_cooldown);
        let new_settings = Self::get_settings(env.clone());

        events::emit_config_updated(&env, &old_settings, &new_settings);
    }

    /// Update the maximum proposals allowed per rate-limit period.
    ///
    /// Authorization is restricted to the governor's own contract address.
    pub fn update_max_proposals_per_period(env: Env, max_proposals_per_period: u32) {
        env.current_contract_address().require_auth();
        assert!(
            max_proposals_per_period > 0,
            "max proposals per period must be positive"
        );

        let old_settings = Self::get_settings(env.clone());
        env.storage().instance().set(
            &DataKey::MaxProposalsPerPeriod,
            &max_proposals_per_period,
        );
        let new_settings = Self::get_settings(env.clone());

        events::emit_config_updated(&env, &old_settings, &new_settings);
    }

    /// Get total proposal count.
    pub fn proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }

    /// Get the ledger sequence of the last proposal by an address.
    pub fn last_proposal_ledger(env: Env, address: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::LastProposalLedger(address))
            .unwrap_or(0)
    }

    /// Get the number of proposals made by an address in the current period.
    pub fn proposals_in_period(env: Env, address: Address) -> u32 {
        let period_duration: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalPeriodDuration)
            .unwrap_or(10_000);
        let current_ledger = env.ledger().sequence();
        let current_period = current_ledger / period_duration;
        env.storage()
            .persistent()
            .get(&DataKey::ProposalsInPeriod(address, current_period))
            .unwrap_or(0)
    }

    /// Check whether an address can currently submit a proposal.
    ///
    /// Returns a structured result indicating if the address is allowed to propose
    /// and the reason if not allowed. This combines all proposal eligibility checks
    /// into a single RPC call: paused state, proposal threshold, cooldown period,
    /// and rate limit per period.
    pub fn can_propose(env: Env, proposer: Address) -> CanProposeResult {
        // Check if contract is paused
        let is_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false);
        if is_paused {
            return CanProposeResult {
                allowed: false,
                reason: symbol_short!("paused"),
                cooldown_ends_at: None,
                proposals_this_period: 0,
                max_per_period: 0,
                voting_power: 0,
                threshold: 0,
            };
        }

        // Get voting power
        let votes_token: Address = env
            .storage()
            .instance()
            .get(&DataKey::VotesToken)
            .unwrap();
        let votes_client = VotesClient::new(&env, &votes_token);
        let voting_power = votes_client.get_votes(&proposer);

        // Check proposal threshold
        let threshold: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalThreshold)
            .unwrap_or(0);
        if voting_power < threshold {
            return CanProposeResult {
                allowed: false,
                reason: symbol_short!("threshold"),
                cooldown_ends_at: None,
                proposals_this_period: 0,
                max_per_period: 0,
                voting_power,
                threshold,
            };
        }

        // Check cooldown period
        let current_ledger = env.ledger().sequence();
        let cooldown: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCooldown)
            .unwrap_or(100);
        let last_proposal_ledger: Option<u32> = env
            .storage()
            .persistent()
            .get(&DataKey::LastProposalLedger(proposer.clone()));
        if let Some(last) = last_proposal_ledger {
            if current_ledger < last + cooldown {
                return CanProposeResult {
                    allowed: false,
                    reason: symbol_short!("cooldown"),
                    cooldown_ends_at: Some(last + cooldown),
                    proposals_this_period: 0,
                    max_per_period: 0,
                    voting_power,
                    threshold,
                };
            }
        }

        // Check rate limit per period
        let period_duration: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalPeriodDuration)
            .unwrap_or(10_000);
        let max_per_period: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MaxProposalsPerPeriod)
            .unwrap_or(5);
        let current_period = current_ledger / period_duration;
        let proposals_this_period: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::ProposalsInPeriod(
                proposer.clone(),
                current_period,
            ))
            .unwrap_or(0);
        if proposals_this_period >= max_per_period {
            return CanProposeResult {
                allowed: false,
                reason: symbol_short!("ratelimit"),
                cooldown_ends_at: None,
                proposals_this_period,
                max_per_period,
                voting_power,
                threshold,
            };
        }

        // All checks passed
        CanProposeResult {
            allowed: true,
            reason: symbol_short!("ok"),
            cooldown_ends_at: None,
            proposals_this_period,
            max_per_period,
            voting_power,
            threshold,
        }
    }

    /// Get the vote reason for a specific voter on a proposal.
    pub fn get_vote_reason(env: Env, proposal_id: u64, voter: Address) -> Option<String> {
        env.storage()
            .persistent()
            .get(&DataKey::VoteReason(proposal_id, voter))
    }

    /// Get the voting receipt for a specific voter on a proposal.
    ///
    /// Returns a VotingReceipt containing whether the voter has voted, their
    /// support choice, the weight of their vote, and any reason provided.
    pub fn get_receipt(env: Env, proposal_id: u64, voter: Address) -> VotingReceipt {
        env.storage()
            .persistent()
            .get(&DataKey::VoteReceipt(proposal_id, voter))
            .unwrap_or(VotingReceipt {
                has_voted: false,
                support: VoteSupport::Against,
                weight: 0,
                reason: String::from_str(&env, ""),
            })
    }

    /// Get the active voting strategy.
    pub fn voting_strategy(env: Env) -> VotingStrategy {
        env.storage()
            .instance()
            .get(&DataKey::VotingStrategy)
            .unwrap_or(VotingStrategy::Single)
    }

    /// Set the voting strategy (governance-gated: must be called via proposal).
    ///
    /// For MultiToken strategy, a maximum of 5 tokens is enforced.
    pub fn set_voting_strategy(env: Env, strategy: VotingStrategy) {
        env.current_contract_address().require_auth();
        if let VotingStrategy::MultiToken(ref tokens) = strategy {
            if tokens.len() > 5 {
                env.panic_with_error(GovernorError::TooManyTokens);
            }
        }
        env.storage()
            .instance()
            .set(&DataKey::VotingStrategy, &strategy);
    }

    /// Update Reflector oracle settings for dynamic quorum (governance-gated).
    pub fn update_oracle(
        env: Env,
        oracle: Option<Address>,
        min_quorum_usd: i128,
        use_dynamic: bool,
    ) {
        env.current_contract_address().require_auth();
        env.storage()
            .instance()
            .set(&DataKey::UseDynamicQuorum, &use_dynamic);
        env.storage()
            .instance()
            .set(&DataKey::MinQuorumUsd, &min_quorum_usd);
        match oracle {
            Some(addr) => env
                .storage()
                .instance()
                .set(&DataKey::ReflectorOracle, &addr),
            None => env.storage().instance().remove(&DataKey::ReflectorOracle),
        }
    }

    /// Compute snapshot vote weight for `voter` at `ledger` using the active strategy.
    fn checked_add(env: &Env, lhs: i128, rhs: i128) -> i128 {
        lhs.checked_add(rhs)
            .unwrap_or_else(|| env.panic_with_error(GovernorError::ArithmeticOverflow))
    }

    /// Compute `value * weight_bps / 10000` with overflow checks.
    fn checked_weight_bps(env: &Env, value: i128, weight_bps: u32) -> i128 {
        value
            .checked_mul(weight_bps as i128)
            .unwrap_or_else(|| env.panic_with_error(GovernorError::ArithmeticOverflow))
            / 10_000
    }

    /// Compute weighted total supply for quorum under the active voting strategy.
    fn compute_quorum_supply(env: &Env, ledger: &u32, strategy: &VotingStrategy) -> i128 {
        match strategy {
            VotingStrategy::Single => {
                let votes_token_addr: Address = env
                    .storage()
                    .instance()
                    .get(&DataKey::VotesToken)
                    .unwrap_or_else(|| env.panic_with_error(GovernorError::VotesTokenNotSet));
                VotesClient::new(env, &votes_token_addr).get_past_total_supply(ledger)
            }
            VotingStrategy::MultiToken(tokens) => {
                let mut total: i128 = 0;
                for wt in tokens.iter() {
                    let supply =
                        match VotesClient::new(env, &wt.token).try_get_past_total_supply(ledger) {
                            Ok(Ok(supply)) => supply,
                            _ => 0,
                        };
                    let weighted = Self::checked_weight_bps(env, supply, wt.weight_bps);
                    total = Self::checked_add(env, total, weighted);
                }
                total
            }
        }
    }

    /// Compute snapshot vote weight for `voter` at `ledger` using the active strategy.
    fn compute_votes(env: &Env, voter: &Address, ledger: &u32) -> i128 {
        let strategy: VotingStrategy = env
            .storage()
            .instance()
            .get(&DataKey::VotingStrategy)
            .unwrap_or(VotingStrategy::Single);
        match strategy {
            VotingStrategy::Single => {
                let votes_token: Address = env
                    .storage()
                    .instance()
                    .get(&DataKey::VotesToken)
                    .unwrap_or_else(|| env.panic_with_error(GovernorError::VotesTokenNotSet));
                VotesClient::new(env, &votes_token).get_past_votes(voter, ledger)
            }
            VotingStrategy::MultiToken(tokens) => {
                let mut total: i128 = 0;
                for wt in tokens.iter() {
                    let votes =
                        match VotesClient::new(env, &wt.token).try_get_past_votes(voter, ledger) {
                            Ok(Ok(votes)) => votes,
                            _ => 0,
                        };
                    let weighted = Self::checked_weight_bps(env, votes, wt.weight_bps);
                    total = Self::checked_add(env, total, weighted);
                }
                total
            }
        }
    }

    /// Compute current vote weight for `proposer` using the active strategy.
    fn compute_proposer_votes(env: &Env, proposer: &Address) -> i128 {
        let strategy: VotingStrategy = env
            .storage()
            .instance()
            .get(&DataKey::VotingStrategy)
            .unwrap_or(VotingStrategy::Single);
        match strategy {
            VotingStrategy::Single => {
                let votes_token: Address = env
                    .storage()
                    .instance()
                    .get(&DataKey::VotesToken)
                    .unwrap_or_else(|| env.panic_with_error(GovernorError::VotesTokenNotSet));
                VotesClient::new(env, &votes_token).get_votes(proposer)
            }
            VotingStrategy::MultiToken(tokens) => {
                let mut total: i128 = 0;
                for wt in tokens.iter() {
                    let votes = match VotesClient::new(env, &wt.token).try_get_votes(proposer) {
                        Ok(Ok(votes)) => votes,
                        _ => 0,
                    };
                    let weighted = Self::checked_weight_bps(env, votes, wt.weight_bps);
                    total = Self::checked_add(env, total, weighted);
                }
                total
            }
        }
    }

    /// Upgrade the governor contract to a new WASM implementation.
    ///
    /// Authorization is restricted to the governor's own contract address.
    /// This means the call must originate from an executed on-chain proposal:
    /// the timelock invokes `upgrade` on behalf of a passed vote, with the
    /// governor contract itself as the authorised principal.
    ///
    /// Upgrade flow:
    ///   1. A proposer creates a proposal whose calldata targets `upgrade(hash)`
    ///   2. Token holders vote; quorum and majority are reached
    ///   3. The proposal is queued in the Timelock with the configured delay
    ///   4. After the delay, anyone triggers execution
    ///   5. The Timelock calls `governor.upgrade(hash)` as an authorised
    ///      sub-invocation of the contract's own address
    ///   6. `env.deployer().update_current_contract_wasm` replaces the WASM;
    ///      the contract address, balance, and storage all remain intact
    ///
    /// If the new WASM changes the storage layout, call `migrate` immediately
    /// after this in the same proposal's calldata.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        env.current_contract_address().require_auth();
        let old_wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::CurrentWasmHash)
            .unwrap_or(BytesN::from_array(&env, &[0u8; 32]));
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        env.storage()
            .instance()
            .set(&DataKey::CurrentWasmHash, &new_wasm_hash);
        events::emit_governor_upgraded(&env, &old_wasm_hash, &new_wasm_hash);
    }

    /// Migrate contract storage after a WASM upgrade.
    ///
    /// Like `upgrade`, this can only be called from the governor's own address
    /// and must therefore be triggered through an executed on-chain proposal.
    ///
    /// This is a no-op stub. When a future upgrade introduces changes to the
    /// on-chain storage layout, extend [`MigrateData`] with the required
    /// values and implement the migration logic here.
    pub fn migrate(env: Env, _data: MigrateData) {
        env.current_contract_address().require_auth();
        // TODO: implement storage migration logic when a breaking storage
        // change is introduced in a future upgrade.
    }

    // ============================================================================
    // Emergency Pause Mechanism (Issue #191)
    // ============================================================================

    /// Pause the contract to prevent critical operations during emergencies.
    /// Only the pauser role can call this function.
    pub fn pause(env: Env, caller: Address) {
        caller.require_auth();

        let pauser: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pauser)
            .unwrap_or_else(|| env.panic_with_error(GovernorError::PauserNotSet));

        if caller != pauser {
            env.panic_with_error(GovernorError::UnauthorizedPause);
        }

        env.storage().instance().set(&DataKey::IsPaused, &true);

        events::emit_paused(&env, &caller);
    }

    /// Unpause the contract to resume normal operations.
    /// Callable by the designated pauser address (same as pause()).
    pub fn unpause(env: Env, caller: Address) {
        caller.require_auth();

        let pauser: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pauser)
            .unwrap_or_else(|| env.panic_with_error(GovernorError::PauserNotSet));

        if caller != pauser {
            env.panic_with_error(GovernorError::UnauthorizedPause);
        }

        env.storage().instance().set(&DataKey::IsPaused, &false);

        events::emit_unpaused(&env);
    }

    /// Check if the contract is currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false)
    }

    /// Get the current pauser address.
    pub fn pauser(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Pauser)
            .unwrap_or_else(|| env.panic_with_error(GovernorError::PauserNotSet))
    }

    /// Update the pauser address (governance-gated).
    pub fn set_pauser(env: Env, new_pauser: Address) {
        env.current_contract_address().require_auth();

        let old_pauser: Address = env
            .storage()
            .instance()
            .get(&DataKey::Pauser)
            .unwrap_or_else(|| env.panic_with_error(GovernorError::PauserNotSet));

        env.storage().instance().set(&DataKey::Pauser, &new_pauser);

        env.events().publish(
            (Symbol::new(&env, "PauserChanged"),),
            (old_pauser, new_pauser),
        );
    }

    // ============================================================================
    // UUPS Proxy Pattern (Issue #195)
    // ============================================================================

    /// Get the implementation address for UUPS proxy pattern.
    /// For native Soroban upgradeability, this returns the current contract address.
    pub fn implementation(env: Env) -> Address {
        env.current_contract_address()
    }

    /// Get the proxy admin address (for UUPS pattern compatibility).
    /// Returns the contract's own address since upgrades are governance-gated.
    pub fn proxy_admin(env: Env) -> Address {
        env.current_contract_address()
    }

    /// Get the ledger sequence when a proposal was queued.
    pub fn get_queue_time(env: Env, proposal_id: u64) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::QueueTime(proposal_id))
            .unwrap_or(0)
    }

    /// Get the timelock operation IDs for a queued proposal.
    ///
    /// Returns an empty vector for proposals that have not been queued yet.
    /// Panics if the proposal does not exist.
    pub fn get_queued_op_ids(env: Env, proposal_id: u64) -> Vec<Bytes> {
        let proposal = Self::must_get_proposal(&env, proposal_id);
        proposal.op_ids
    }

    /// Get a proposal by ID.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Proposal {
        Self::must_get_proposal(&env, proposal_id)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        contract, contractimpl,
        testutils::{Address as _, Events, Ledger as _},
        Bytes, Env, Symbol, TryIntoVal,
    };

    /// Mock votes contract that returns a high vote count for any address,
    /// allowing propose() to pass the threshold check in unit tests.
    #[contract]
    pub struct MockVotesContract;

    #[contractimpl]
    impl MockVotesContract {
        pub fn get_votes(_env: Env, _account: Address) -> i128 {
            // Return a high vote count that exceeds any reasonable threshold
            1_000_000
        }

        pub fn get_past_votes(_env: Env, _account: Address, _ledger: u32) -> i128 {
            // Return a fixed snapshot voting power for cast_vote() tests
            1_000_000
        }

        pub fn get_past_total_supply(_env: Env, _ledger: u32) -> i128 {
            // Return a fixed total supply for quorum calculations in tests
            10_000_000
        }
    }

    /// Shared helper: initialize the governor and return a proposal id using a
    /// dummy target so the existing vote-with-reason tests remain focused on
    /// their specific behaviour without needing a real timelock or target.
    fn propose_dummy(env: &Env, client: &GovernorContractClient, proposer: &Address) -> u64 {
        let target = Address::generate(env);
        let fn_name = Symbol::new(env, "exec");
        let calldata = Bytes::new(env);
        let description = String::from_str(env, "Test proposal");

        // Compute SHA-256 hash of the description
        let description_hash = env
            .crypto()
            .sha256(&Bytes::from_slice(env, b"Test proposal"))
            .into();

        // Dummy metadata URI (could be ipfs or https)
        let metadata_uri = String::from_str(env, "https://example.com/proposal/1");

        // Create Vec with single target, fn_name, and calldata
        let mut targets = soroban_sdk::Vec::new(env);
        targets.push_back(target);

        let mut fn_names = soroban_sdk::Vec::new(env);
        fn_names.push_back(fn_name);

        let mut calldatas = soroban_sdk::Vec::new(env);
        calldatas.push_back(calldata);

        client.propose(
            proposer,
            &description,
            &description_hash,
            &metadata_uri,
            &targets,
            &fn_names,
            &calldatas,
        )
    }

    #[test]
    fn test_cast_vote_with_reason_stores_reason() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        let guardian = Address::generate(&env);
        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &100,
            &1000,
            &50,
            &1000,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        let proposal_id = propose_dummy(&env, &client, &proposer);

        let reason = String::from_str(&env, "I support this because it improves governance");
        client.cast_vote_with_reason(&voter, &proposal_id, &VoteSupport::For, &reason);

        let stored_reason = client.get_vote_reason(&proposal_id, &voter);
        assert_eq!(stored_reason, Some(reason));
    }

    #[test]
    fn test_cast_vote_with_reason_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        let guardian = Address::generate(&env);
        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &100,
            &1000,
            &50,
            &1000,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 101);

        let reason = String::from_str(&env, "This aligns with our community values");
        client.cast_vote_with_reason(&voter, &proposal_id, &VoteSupport::For, &reason);

        let events = env.events().all();

        let has_vote_rsn = events.iter().any(|(_, topics, _)| {
            !topics.is_empty() && {
                let first: Result<soroban_sdk::Symbol, _> =
                    topics.get(0).unwrap().try_into_val(&env);
                first.is_ok() && first.unwrap() == Symbol::new(&env, "VoteCastWithReason")
            }
        });

        assert!(has_vote_rsn, "VoteCastWithReason event not emitted");
    }

    #[test]
    fn test_cast_vote_with_reason_multiple_voters() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter1 = Address::generate(&env);
        let voter2 = Address::generate(&env);

        let guardian = Address::generate(&env);
        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &100,
            &1000,
            &50,
            &1000,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        let proposal_id = propose_dummy(&env, &client, &proposer);

        let reason1 = String::from_str(&env, "I agree with this proposal");
        let reason2 = String::from_str(&env, "I disagree with this proposal");

        client.cast_vote_with_reason(&voter1, &proposal_id, &VoteSupport::For, &reason1);
        client.cast_vote_with_reason(&voter2, &proposal_id, &VoteSupport::Against, &reason2);

        let stored_reason1 = client.get_vote_reason(&proposal_id, &voter1);
        let stored_reason2 = client.get_vote_reason(&proposal_id, &voter2);

        assert_eq!(stored_reason1, Some(reason1));
        assert_eq!(stored_reason2, Some(reason2));
    }

    #[test]
    fn test_quorum_and_state() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        // Deploy a real SEP-41 token and TokenVotes contract so the voter
        // has actual snapshot voting power for the cross-contract lookup.
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        let sac_client = soroban_sdk::token::StellarAssetClient::new(&env, &token_addr);

        let votes_id = env.register(sorogov_token_votes::TokenVotesContract, ());
        let votes_client = sorogov_token_votes::TokenVotesContractClient::new(&env, &votes_id);
        votes_client.initialize(&admin, &token_addr);

        // Mint tokens and self-delegate so the voter has snapshot voting power.
        sac_client.mint(&voter, &1000_i128);
        votes_client.delegate(&voter, &voter);

        // Initialize governor with 50% quorum (50 / 100).
        let guardian = Address::generate(&env);
        client.initialize(
            &admin,
            &votes_id,
            &timelock,
            &0,
            &100,
            &50,
            &0,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance ledger to start voting.
        env.ledger().with_mut(|li| li.sequence_number += 1);

        // cast_vote now looks up snapshot voting power from token-votes.
        client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

        // Advance ledger to end voting.
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Quorum is 0 (total supply at start_ledger=0 is 1000, 50% = 500,
        // but start_ledger checkpoint may be 0 depending on delegation timing).
        // With 1000 votes For, the proposal succeeds regardless.
        assert_eq!(client.state(&proposal_id), ProposalState::Succeeded);
    }

    #[test]
    fn test_is_quorum_reached() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let timelock = Address::generate(&env);
        let proposer1 = Address::generate(&env);
        let proposer2 = Address::generate(&env);
        let proposer3 = Address::generate(&env);
        let voter1 = Address::generate(&env);
        let voter2 = Address::generate(&env);

        // Deploy a real SEP-41 token and TokenVotes contract.
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        let sac_client = soroban_sdk::token::StellarAssetClient::new(&env, &token_addr);

        let votes_id = env.register(sorogov_token_votes::TokenVotesContract, ());
        let votes_client = sorogov_token_votes::TokenVotesContractClient::new(&env, &votes_id);
        votes_client.initialize(&admin, &token_addr);

        // Mint tokens: voter1 has 400, voter2 has 600, total 1000
        sac_client.mint(&voter1, &400_i128);
        sac_client.mint(&voter2, &600_i128);
        votes_client.delegate(&voter1, &voter1);
        votes_client.delegate(&voter2, &voter2);

        // Initialize governor with 50% quorum (50 / 100 = 500 required).
        let guardian = Address::generate(&env);
        client.initialize(
            &admin,
            &votes_id,
            &timelock,
            &0,
            &100,
            &50,
            &0,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        // Case 1: Not enough votes for quorum (400 For < 500)
        let proposal_id = propose_dummy(&env, &client, &proposer1);
        env.ledger().with_mut(|li| li.sequence_number = 1);
        client.cast_vote(&voter1, &proposal_id, &VoteSupport::For);
        env.ledger().with_mut(|li| li.sequence_number = 1000);
        assert!(!client.is_quorum_reached(&proposal_id));
        assert_eq!(client.state(&proposal_id), ProposalState::Defeated);

        // Case 2: Exactly at quorum threshold (0 For + 600 Abstain = 600 >= 500)
        env.ledger().with_mut(|li| li.sequence_number = 101);
        let proposal_id2 = propose_dummy(&env, &client, &proposer2);
        env.ledger().with_mut(|li| li.sequence_number = 102);
        client.cast_vote(&voter1, &proposal_id2, &VoteSupport::Against);
        client.cast_vote(&voter2, &proposal_id2, &VoteSupport::Abstain);
        env.ledger().with_mut(|li| li.sequence_number = 1000);
        assert!(client.is_quorum_reached(&proposal_id2));
        // But still defeated because For (0) <= Against (400)
        assert_eq!(client.state(&proposal_id2), ProposalState::Defeated);

        // Case 3: Above quorum (600 For > 500)
        env.ledger().with_mut(|li| li.sequence_number = 202);
        let proposal_id3 = propose_dummy(&env, &client, &proposer3);
        env.ledger().with_mut(|li| li.sequence_number = 203);
        client.cast_vote(&voter2, &proposal_id3, &VoteSupport::For);
        env.ledger().with_mut(|li| li.sequence_number = 1000);
        assert!(client.is_quorum_reached(&proposal_id3));
        assert_eq!(client.state(&proposal_id3), ProposalState::Succeeded);
    }

    #[test]
    fn test_propose_with_multiple_targets() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let proposer = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);

        // Set threshold to 100
        let guardian = Address::generate(&env);
        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &100,
            &1000,
            &50,
            &100,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        // Create proposal with multiple targets
        let target1 = Address::generate(&env);
        let target2 = Address::generate(&env);
        let fn_name1 = Symbol::new(&env, "action1");
        let fn_name2 = Symbol::new(&env, "action2");
        let calldata1 = Bytes::from_slice(&env, &[1, 2, 3]);
        let calldata2 = Bytes::from_slice(&env, &[4, 5, 6]);
        let description = String::from_str(&env, "Multi-target proposal");

        let mut targets = soroban_sdk::Vec::new(&env);
        targets.push_back(target1.clone());
        targets.push_back(target2.clone());

        let mut fn_names = soroban_sdk::Vec::new(&env);
        fn_names.push_back(fn_name1.clone());
        fn_names.push_back(fn_name2.clone());

        let mut calldatas = soroban_sdk::Vec::new(&env);
        calldatas.push_back(calldata1.clone());
        calldatas.push_back(calldata2.clone());

        let description_hash = env
            .crypto()
            .sha256(&Bytes::from_slice(&env, b"Multi-target proposal"))
            .into();
        let metadata_uri = String::from_str(&env, "ipfs://QmMulti");

        let proposal_id = client.propose(
            &proposer,
            &description,
            &description_hash,
            &metadata_uri,
            &targets,
            &fn_names,
            &calldatas,
        );

        // Verify proposal was created
        assert_eq!(proposal_id, 1);
        assert_eq!(client.proposal_count(), 1);
    }

    #[test]
    #[should_panic]
    fn test_propose_rejects_mismatched_lengths() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let proposer = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);

        let guardian = Address::generate(&env);
        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &100,
            &1000,
            &50,
            &100,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        let target = Address::generate(&env);
        let fn_name = Symbol::new(&env, "exec");
        let calldata1 = Bytes::new(&env);
        let calldata2 = Bytes::new(&env);
        let description = String::from_str(&env, "Mismatched proposal");

        let mut targets = soroban_sdk::Vec::new(&env);
        targets.push_back(target);

        let mut fn_names = soroban_sdk::Vec::new(&env);
        fn_names.push_back(fn_name);

        let mut calldatas = soroban_sdk::Vec::new(&env);
        calldatas.push_back(calldata1);
        calldatas.push_back(calldata2); // Extra calldata

        let description_hash = env
            .crypto()
            .sha256(&Bytes::from_slice(&env, b"Mismatched proposal"))
            .into();
        let metadata_uri = String::from_str(&env, "ipfs://QmMismatch");

        // Should panic with "targets, fn_names, and calldatas length mismatch"
        client.propose(
            &proposer,
            &description,
            &description_hash,
            &metadata_uri,
            &targets,
            &fn_names,
            &calldatas,
        );
    }

    #[test]
    #[should_panic]
    fn test_propose_rejects_empty_targets() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let proposer = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);

        let guardian = Address::generate(&env);
        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &100,
            &1000,
            &50,
            &100,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        let description = String::from_str(&env, "Empty proposal");
        let targets = soroban_sdk::Vec::new(&env);
        let fn_names = soroban_sdk::Vec::new(&env);
        let calldatas = soroban_sdk::Vec::new(&env);

        let description_hash = env
            .crypto()
            .sha256(&Bytes::from_slice(&env, b"Empty proposal"))
            .into();
        let metadata_uri = String::from_str(&env, "ipfs://QmEmpty");

        // Should panic with "must have at least one target"
        client.propose(
            &proposer,
            &description,
            &description_hash,
            &metadata_uri,
            &targets,
            &fn_names,
            &calldatas,
        );
    }

    /// Mock oracle contract that returns a fixed price for dynamic quorum tests.
    #[contract]
    pub struct MockOracleContract;

    #[contractimpl]
    impl MockOracleContract {
        pub fn lastprice(_env: Env, _asset: Address) -> Option<i128> {
            Some(5_000_000) // $5.00 in 6-decimal format
        }
    }

    #[test]
    fn test_cancel_proposer_pending() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);

        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &100,
            &1000,
            &50,
            &1000,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Proposer should be able to cancel pending proposal
        client.cancel(&proposer, &proposal_id);
        assert_eq!(client.state(&proposal_id), ProposalState::Cancelled);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_cancel_proposer_active_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);

        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &100,
            &1000,
            &50,
            &1000,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Proposer should not be able to cancel active proposal
        client.cancel(&proposer, &proposal_id);
    }

    #[test]
    fn test_cancel_guardian_active() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);

        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &100,
            &1000,
            &50,
            &1000,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Guardian should be able to cancel active proposal
        client.cancel(&guardian, &proposal_id);
        assert_eq!(client.state(&proposal_id), ProposalState::Cancelled);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #1)")]
    fn test_cancel_guardian_pending_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);

        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &100,
            &1000,
            &50,
            &1000,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Guardian should not be able to cancel pending proposal
        client.cancel(&guardian, &proposal_id);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #2)")]
    fn test_vote_type_simple_rejects_abstain() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &100,
            &1000,
            &50,
            &1000,
            &guardian,
            &VoteType::Simple,
            &120_960,
        );

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Should panic with InvalidSupport when trying to abstain in Simple mode
        client.cast_vote(&voter, &proposal_id, &VoteSupport::Abstain);
    }

    #[test]
    fn test_vote_type_quadratic_weighting() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &100,
            &1000,
            &50,
            &1000,
            &guardian,
            &VoteType::Quadratic,
            &120_960,
        );

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Cast vote - raw weight is 1_000_000, quadratic should be sqrt(1_000_000) = 1000
        client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

        let (votes_for, _, _) = client.proposal_votes(&proposal_id);
        assert_eq!(votes_for, 1000); // Quadratic weighting applied
    }

    #[test]
    fn test_proposal_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &0,
            &100,
            &0,
            &0,
            &guardian,
            &VoteType::Extended,
            &100,
        ); // Short grace period

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 1);

        // Vote to make it succeed
        client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

        // Advance past voting period
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Should be Succeeded initially
        assert_eq!(client.state(&proposal_id), ProposalState::Succeeded);

        // Advance past grace period
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Should now be Expired
        assert_eq!(client.state(&proposal_id), ProposalState::Expired);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, #3)")]
    fn test_queue_expired_proposal_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &0,
            &100,
            &0,
            &0,
            &guardian,
            &VoteType::Extended,
            &100,
        ); // Short grace period

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 1);

        // Vote to make it succeed
        client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

        // Advance past voting period and grace period
        env.ledger().with_mut(|li| li.sequence_number += 201);

        // Should be Expired
        assert_eq!(client.state(&proposal_id), ProposalState::Expired);

        // Should panic when trying to queue expired proposal
        client.queue(&proposal_id);
    }

    #[test]
    fn test_multi_token_weighted_voting() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        // Register two mock token contracts.
        let token_a_id = env.register(MockVotesContract, ());
        let token_b_id = env.register(MockVotesContract, ());

        // Initialize governor with a single-token strategy first (standard init).
        client.initialize(
            &admin,
            &token_a_id,
            &timelock,
            &100,
            &1000,
            &0,
            &0,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        // Build MultiToken strategy: token_a at 1x (10000 bps), token_b at 2x (20000 bps).
        let mut weighted_tokens = soroban_sdk::Vec::new(&env);
        weighted_tokens.push_back(WeightedToken {
            token: token_a_id.clone(),
            weight_bps: 10_000,
        });
        weighted_tokens.push_back(WeightedToken {
            token: token_b_id.clone(),
            weight_bps: 20_000,
        });
        client.set_voting_strategy(&VotingStrategy::MultiToken(weighted_tokens));

        // Verify strategy is stored correctly.
        let stored = client.voting_strategy();
        assert!(
            matches!(stored, VotingStrategy::MultiToken(_)),
            "strategy should be MultiToken"
        );

        // Create a proposal.
        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance ledger into the voting window.
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Cast vote — each MockVotesContract returns 1_000_000 for get_past_votes.
        // Expected weight: 1_000_000 * 10000/10000 + 1_000_000 * 20000/10000 = 3_000_000
        client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

        let (votes_for, _, _) = client.proposal_votes(&proposal_id);
        assert_eq!(
            votes_for, 3_000_000,
            "weighted votes should total 3_000_000"
        );
    }

    #[test]
    fn test_dynamic_quorum_with_oracle() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);

        // 10% static quorum: supply=10_000_000, so static = 1_000_000.
        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &100,
            &1000,
            &10,
            &0,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        // Create a proposal to get a proposal_id.
        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Without dynamic quorum, quorum == 10% of 10_000_000 = 1_000_000.
        let static_q = client.quorum(&proposal_id);
        assert_eq!(static_q, 1_000_000, "static quorum should be 1_000_000");

        // Register the mock oracle ($5.00 per token, 6-decimal format).
        let oracle_id = env.register(MockOracleContract, ());

        // Enable dynamic quorum: min_quorum_usd = 20_000_000 ($20 in 6-decimal),
        // price = 5_000_000 ($5), so usd_quorum = 20_000_000 / 5_000_000 = 4.
        // usd_quorum (4) < static_quorum (1_000_000), so static wins.
        client.update_oracle(&Some(oracle_id.clone()), &20_000_000_i128, &true);
        let dynamic_q = client.quorum(&proposal_id);
        assert_eq!(
            dynamic_q, 1_000_000,
            "dynamic quorum should equal static when static is larger"
        );

        // Now set a very high USD floor that translates to more tokens than static quorum.
        // usd_quorum = min_quorum_usd / price = 10_000_000_000_000 / 5_000_000 = 2_000_000.
        // 2_000_000 > static_quorum (1_000_000), so dynamic wins.
        client.update_oracle(&Some(oracle_id.clone()), &10_000_000_000_000_i128, &true);
        let high_dynamic_q = client.quorum(&proposal_id);
        assert_eq!(
            high_dynamic_q, 2_000_000,
            "dynamic quorum should use USD floor when larger than static"
        );

        // Test fallback: disable dynamic quorum and verify static quorum is used.
        client.update_oracle(&Some(oracle_id.clone()), &10_000_000_000_000_i128, &false);
        let fallback_q = client.quorum(&proposal_id);
        assert_eq!(
            fallback_q, 1_000_000,
            "should fall back to static quorum when dynamic is disabled"
        );
    }

    #[test]
    fn test_get_receipt_returns_voting_details() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &100,
            &1000,
            &50,
            &1000,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Before voting, receipt should show has_voted = false
        let receipt_before = client.get_receipt(&proposal_id, &voter);
        assert!(!receipt_before.has_voted);
        assert_eq!(receipt_before.weight, 0);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Cast vote with reason
        let reason = String::from_str(&env, "I support this proposal");
        client.cast_vote_with_reason(&voter, &proposal_id, &VoteSupport::For, &reason);

        // After voting, receipt should contain all details
        let receipt_after = client.get_receipt(&proposal_id, &voter);
        assert!(receipt_after.has_voted);
        assert_eq!(receipt_after.support, VoteSupport::For);
        assert_eq!(receipt_after.weight, 1_000_000); // MockVotesContract returns 1_000_000
        assert_eq!(receipt_after.reason, reason);
    }

    #[test]
    #[should_panic]
    fn test_cannot_vote_twice() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &100,
            &1000,
            &50,
            &1000,
            &guardian,
            &VoteType::Extended,
            &120_960,
        );

        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Advance to active state
        env.ledger().with_mut(|li| li.sequence_number += 101);

        // Cast first vote
        client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

        // Attempt to vote again should panic
        client.cast_vote(&voter, &proposal_id, &VoteSupport::Against);
    }

    #[test]
    fn test_long_running_proposal_ttl_extended() {
        // Regression test for: Proposal storage TTL not extended — long-running proposals can expire before execution
        // This test verifies that proposals with long voting periods have their storage TTL extended
        // to prevent expiration mid-lifecycle.
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(GovernorContract, ());
        let client = GovernorContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let votes_token_id = env.register(MockVotesContract, ());
        let timelock = Address::generate(&env);
        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        // Initialize with long voting period: 30 days ≈ 259,200 ledgers (at 10 sec blocks)
        let long_voting_period = 259_200u32;
        let voting_delay = 100u32;
        
        client.initialize(
            &admin,
            &votes_token_id,
            &timelock,
            &voting_delay,
            &long_voting_period,
            &50,
            &1000,
            &guardian,
            &VoteType::Extended,
            &120_960, // grace period
        );

        // Create proposal — should extend TTL
        let proposal_id = propose_dummy(&env, &client, &proposer);

        // Verify proposal is created successfully
        let state = client.state(&proposal_id);
        assert_eq!(state, ProposalState::Pending);

        // Advance to active state (voting_delay ledgers)
        env.ledger().with_mut(|li| li.sequence_number += voting_delay + 1);
        assert_eq!(client.state(&proposal_id), ProposalState::Active);

        // Cast vote — should extend TTL again
        client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

        // Verify votes are recorded
        let (votes_for, _, _) = client.proposal_votes(&proposal_id);
        assert_eq!(votes_for, 1_000_000);

        // Advance well into the long voting period (but not past end)
        let mid_voting_period = voting_delay + (long_voting_period / 2);
        env.ledger().with_mut(|li| li.sequence_number = mid_voting_period);

        // Should still be Active — if TTL wasn't extended, storage might expire
        let state = client.state(&proposal_id);
        assert_eq!(state, ProposalState::Active);

        // Advance to end of voting period
        env.ledger().with_mut(|li| li.sequence_number = voting_delay + long_voting_period + 1);

        // Should transition to Succeeded (since quorum was met and votes_for > votes_against)
        let state = client.state(&proposal_id);
        assert_eq!(state, ProposalState::Succeeded);

        // Verify that get_proposal still works after long period
        let proposal = client.get_proposal(&proposal_id);
        assert_eq!(proposal.votes_for, 1_000_000);
        assert!(!proposal.executed);
    }
}

#[cfg(test)]
mod tests;
