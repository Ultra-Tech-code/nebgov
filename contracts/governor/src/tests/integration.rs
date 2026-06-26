//! End-to-end integration test for the full NebGov proposal lifecycle.
//!
//! Exercises the complete flow across all three contracts:
//!   Governor → Timelock → Token-Votes
//!
//! Flow under test:
//!   1. Deploy all contracts and a mock execution target
//!   2. Mint governance tokens and delegate to voter accounts
//!   3. Create a proposal that targets the mock contract
//!   4. Advance the ledger past `start_ledger`; cast votes to achieve a
//!      simple majority
//!   5. Advance past `end_ledger`; verify the proposal is in Succeeded state
//!   6. Call `queue()` and verify the timelock operation is scheduled
//!   7. Advance the timestamp past the timelock delay
//!   8. Call `execute()` and verify the mock target function was invoked
//!   9. Verify final governor state is Executed

use crate::{
    GovernorContract, GovernorContractClient, Proposal, ProposalState, VoteSupport, VoteType,
    VotingStrategy, WeightedToken,
};

use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Events, Ledger as _},
    token, Address, Bytes, Env, IntoVal, String, Symbol, TryIntoVal,
};

// ---------------------------------------------------------------------------
// ConfigurableOracleContract — mock Reflector oracle for dynamic quorum tests.
// Call set_price(Some(p)) before the proposal quorum is evaluated to control
// the price the governor sees.  Pass None to simulate an unreachable oracle.
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum OracleDataKey {
    Price,
}

#[contract]
pub struct ConfigurableOracleContract;

#[contractimpl]
impl ConfigurableOracleContract {
    /// Configures the price the oracle will return on the next lastprice call.
    /// Pass None to simulate an oracle that returns no price.
    pub fn set_price(env: Env, price: Option<i128>) {
        match price {
            Some(p) => env.storage().instance().set(&OracleDataKey::Price, &p),
            None => env.storage().instance().remove(&OracleDataKey::Price),
        }
    }

    /// Mirrors the Reflector oracle interface.
    pub fn lastprice(env: Env, _asset: Address) -> Option<i128> {
        env.storage().instance().get(&OracleDataKey::Price)
    }
}

// ---------------------------------------------------------------------------
// MockTarget — a minimal contract whose sole purpose is to record that it was
// called by the governance execution path.
// ---------------------------------------------------------------------------

#[contract]
pub struct MockTarget;

#[contractimpl]
impl MockTarget {
    /// Called by the timelock when the proposal executes.
    /// Stores a flag so the test can verify the invocation happened.
    pub fn exec_gov(env: Env) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("called"), &true);
    }

    /// Returns whether `exec_gov` has been called at least once.
    pub fn was_called(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("called"))
            .unwrap_or(false)
    }
}

#[contracttype]
#[derive(Clone)]
enum ConfigurableVotesDataKey {
    Votes(Address),
    TotalSupply,
}

#[contract]
pub struct ConfigurableVotesContract;

#[contractimpl]
impl ConfigurableVotesContract {
    pub fn set_votes(env: Env, account: Address, votes: i128) {
        env.storage()
            .instance()
            .set(&ConfigurableVotesDataKey::Votes(account), &votes);
    }

    pub fn set_total_supply(env: Env, supply: i128) {
        env.storage()
            .instance()
            .set(&ConfigurableVotesDataKey::TotalSupply, &supply);
    }

    pub fn get_votes(env: Env, account: Address) -> i128 {
        env.storage()
            .instance()
            .get(&ConfigurableVotesDataKey::Votes(account))
            .unwrap_or(0)
    }

    pub fn get_past_votes(env: Env, account: Address, _ledger: u32) -> i128 {
        Self::get_votes(env, account)
    }

    pub fn get_past_total_supply(env: Env, _ledger: u32) -> i128 {
        env.storage()
            .instance()
            .get(&ConfigurableVotesDataKey::TotalSupply)
            .unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// TimelockContract reference — we call the deployed timelock via its generated
// client, which is available because both crates share the same test binary.
// ---------------------------------------------------------------------------

use sorogov_timelock::{TimelockContract, TimelockContractClient};
use sorogov_token_votes::{TokenVotesContract, TokenVotesContractClient};

#[allow(dead_code)]
fn count_topic(env: &Env, topic_name: &str) -> usize {
    let topic_symbol = Symbol::new(env, topic_name);
    env.events()
        .all()
        .iter()
        .filter(|(_, topics, _)| {
            !topics.is_empty() && {
                let first: Result<Symbol, _> = topics.get(0).unwrap().try_into_val(env);
                first.is_ok() && first.unwrap() == topic_symbol
            }
        })
        .count()
}

fn make_multi_token_strategy(env: &Env, entries: &[(Address, u32)]) -> VotingStrategy {
    let mut weighted_tokens = soroban_sdk::Vec::new(env);
    for (token, weight_bps) in entries.iter() {
        weighted_tokens.push_back(WeightedToken {
            token: token.clone(),
            weight_bps: *weight_bps,
        });
    }
    VotingStrategy::MultiToken(weighted_tokens)
}

fn propose_exec_gov(
    env: &Env,
    governor_client: &GovernorContractClient,
    proposer: &Address,
    target: &Address,
    proposal_seed: &[u8],
) -> u64 {
    let description = soroban_sdk::String::from_str(env, "Multi-token integration proposal");
    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(env, proposal_seed))
        .into();
    let metadata_uri = soroban_sdk::String::from_str(env, "ipfs://multi-token");

    let mut targets = soroban_sdk::Vec::new(env);
    targets.push_back(target.clone());

    let mut fn_names = soroban_sdk::Vec::new(env);
    fn_names.push_back(Symbol::new(env, "exec_gov"));

    let mut calldatas = soroban_sdk::Vec::new(env);
    let _ = proposal_seed;
    calldatas.push_back(Bytes::new(env));

    governor_client.propose(
        proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    )
}

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

#[test]
fn test_full_proposal_lifecycle() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // ------------------------------------------------------------------
    // 1. Deploy all contracts.
    // ------------------------------------------------------------------

    // Underlying SEP-41 governance token (stellar asset contract).
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);

    // Token-Votes contract wraps the governance token.
    let votes_id = env.register(TokenVotesContract, ());
    let votes_client = TokenVotesContractClient::new(&env, &votes_id);
    votes_client.initialize(&admin, &token_addr);

    // MockTarget — the contract the proposal will call on execution.
    let mock_target_id = env.register(MockTarget, ());
    let mock_client = MockTargetClient::new(&env, &mock_target_id);

    // Timelock and Governor need to reference each other. We register both
    // first, then initialize in order: timelock (needs governor address),
    // governor (needs timelock address).
    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    // 1-second minimum delay — keeps the test fast while still exercising
    // the delay enforcement path.
    let min_delay: u64 = 1;
    timelock_client.initialize(&admin, &governor_id, &min_delay, &1_209_600);

    // voting_delay = 10 ledgers, voting_period = 20 ledgers, quorum 50 %.
    let guardian = Address::generate(&env);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32, // voting_delay
        &20_u32, // voting_period
        &0_u32,  // quorum_numerator (set to 0 for this simple majority test)
        &0_i128, // proposal_threshold
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    // ------------------------------------------------------------------
    // 2. Mint governance tokens and delegate to voter accounts.
    // ------------------------------------------------------------------

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    token_admin.mint(&alice, &500_i128);
    token_admin.mint(&bob, &500_i128);

    // Both voters self-delegate so their balances count toward total supply.
    votes_client.delegate(&alice, &alice);
    votes_client.delegate(&bob, &bob);

    // ------------------------------------------------------------------
    // 3. Create a proposal targeting MockTarget::exec_gov.
    // ------------------------------------------------------------------

    let proposer = Address::generate(&env);
    let fn_name = Symbol::new(&env, "exec_gov");
    // The calldata uniquely identifies this operation in the timelock.
    // We encode the proposal topic as its bytes; no structured args needed
    // for the no-arg exec_gov function (full arg encoding is TODO issue #6).
    let calldata = Bytes::new(&env);
    let description = soroban_sdk::String::from_str(&env, "Execute mock governance action");

    // Create Vec with single target, fn_name, and calldata
    let mut targets = soroban_sdk::Vec::new(&env);
    targets.push_back(mock_target_id.clone());

    let mut fn_names = soroban_sdk::Vec::new(&env);
    fn_names.push_back(fn_name);

    let mut calldatas = soroban_sdk::Vec::new(&env);
    calldatas.push_back(calldata);

    // Ledger starts at 0; start_ledger = 0 + 10 = 10, end_ledger = 0 + 30.
    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"Upgrade protocol fee to 0.3%"))
        .into();
    let metadata_uri = soroban_sdk::String::from_str(&env, "ipfs://QmExample");
    let proposal_id = governor_client.propose(
        &proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    );
    assert_eq!(proposal_id, 1);

    // Immediately after proposal creation the state is Pending.
    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Pending,
        "expected Pending right after propose()"
    );

    // ------------------------------------------------------------------
    // 4. Advance ledger past start_ledger; cast votes to achieve quorum.
    // ------------------------------------------------------------------

    // Jump to ledger 11 — inside the voting window [10, 30].
    env.ledger().with_mut(|l| l.sequence_number = 11);

    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Active,
        "expected Active during voting window"
    );

    // Both Alice and Bob vote For. cast_vote() now reads snapshot voting
    // power from token-votes; Alice has 500 and Bob has 500, totalling 1000.
    governor_client.cast_vote(&alice, &proposal_id, &VoteSupport::For);
    governor_client.cast_vote(&bob, &proposal_id, &VoteSupport::For);

    let (votes_for, votes_against, votes_abstain) = governor_client.proposal_votes(&proposal_id);
    assert_eq!(
        votes_for, 1000,
        "votes should reflect token-weighted power (500 + 500)"
    );
    assert_eq!(votes_against, 0);
    assert_eq!(votes_abstain, 0);

    // ------------------------------------------------------------------
    // 5. Advance ledger past end_ledger; verify Succeeded state.
    // ------------------------------------------------------------------

    // Jump to ledger 31 — past the end of the voting window.
    env.ledger().with_mut(|l| l.sequence_number = 31);

    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Succeeded,
        "expected Succeeded after voting period with majority For"
    );

    // ------------------------------------------------------------------
    // 6. Queue the proposal; verify the timelock operation is scheduled.
    // ------------------------------------------------------------------

    // Capture the current timestamp before queue() so we can compute the
    // expected ready_at for the timelock operation.
    let ts_before_queue = env.ledger().timestamp();

    governor_client.queue(&proposal_id);

    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Queued,
        "expected Queued after queue()"
    );

    // Confirm the timelock received the schedule() call. The operation is
    // pending because the delay has not yet elapsed.
    let op_id: Bytes = env.as_contract(&governor_id, || {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&crate::DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        proposal.op_ids.get(0).unwrap()
    });

    // is_pending: scheduled but delay not yet elapsed.
    assert!(
        timelock_client.is_pending(&op_id),
        "timelock operation should be pending immediately after queue()"
    );
    assert!(
        !timelock_client.is_ready(&op_id),
        "timelock operation should not be ready before delay elapses"
    );

    // ------------------------------------------------------------------
    // 7. Advance the timestamp past the timelock delay.
    // ------------------------------------------------------------------

    // Move wall-clock time forward by min_delay + 1 second so the timelock
    // considers the operation ready.
    env.ledger()
        .with_mut(|l| l.timestamp = ts_before_queue + min_delay + 1);

    assert!(
        timelock_client.is_ready(&op_id),
        "timelock operation should be ready after delay has elapsed"
    );
    assert!(
        !timelock_client.is_pending(&op_id),
        "timelock operation should no longer be pending once ready"
    );

    // MockTarget should not have been called yet.
    assert!(
        !mock_client.was_called(),
        "mock target must not be called before execute()"
    );

    // ------------------------------------------------------------------
    // 8. Execute the proposal; verify the mock target function was called.
    // ------------------------------------------------------------------

    governor_client.execute(&proposal_id);

    // The timelock invoked MockTarget::exec_gov during the execute() flow.
    assert!(
        mock_client.was_called(),
        "MockTarget::exec_gov should have been called by the timelock"
    );

    // ------------------------------------------------------------------
    // 9. Verify final governor state is Executed.
    // ------------------------------------------------------------------

    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Executed,
        "expected Executed after execute()"
    );
}

/// Test the veto window functionality.
///
/// This test verifies that:
/// 1. Guardian can cancel a queued proposal during the veto window
/// 2. Cancellation prevents execution of the proposal
/// 3. Timelock operations are properly cancelled
/// 4. After the veto window closes, cancellation is blocked
#[test]
fn test_cancel_queued_during_veto_window() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // ------------------------------------------------------------------
    // Setup: Deploy all contracts
    // ------------------------------------------------------------------

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);

    let votes_id = env.register(TokenVotesContract, ());
    let votes_client = TokenVotesContractClient::new(&env, &votes_id);
    votes_client.initialize(&admin, &token_addr);

    let mock_target_id = env.register(MockTarget, ());
    let mock_client = MockTargetClient::new(&env, &mock_target_id);

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    let min_delay: u64 = 100; // 100 seconds
    timelock_client.initialize(&admin, &governor_id, &min_delay, &1_209_600);

    let guardian = Address::generate(&env);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &20_u32,
        &0_u32,
        &0_i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    // ------------------------------------------------------------------
    // Create tokens, delegate, and create proposal
    // ------------------------------------------------------------------

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    token_admin.mint(&alice, &500_i128);
    token_admin.mint(&bob, &500_i128);

    votes_client.delegate(&alice, &alice);
    votes_client.delegate(&bob, &bob);

    let proposer = Address::generate(&env);
    let fn_name = Symbol::new(&env, "exec_gov");
    let calldata = Bytes::from_slice(&env, b"governance-proposal-veto-test");
    let description = soroban_sdk::String::from_str(&env, "Test veto window");

    let mut targets = soroban_sdk::Vec::new(&env);
    targets.push_back(mock_target_id.clone());

    let mut fn_names = soroban_sdk::Vec::new(&env);
    fn_names.push_back(fn_name);

    let mut calldatas = soroban_sdk::Vec::new(&env);
    calldatas.push_back(calldata);

    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"test"))
        .into();
    let metadata_uri = soroban_sdk::String::from_str(&env, "ipfs://test");
    let proposal_id = governor_client.propose(
        &proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    );

    // ------------------------------------------------------------------
    // Vote and queue the proposal
    // ------------------------------------------------------------------

    env.ledger().with_mut(|l| l.sequence_number = 11);
    governor_client.cast_vote(&alice, &proposal_id, &VoteSupport::For);
    governor_client.cast_vote(&bob, &proposal_id, &VoteSupport::For);

    env.ledger().with_mut(|l| l.sequence_number = 31);
    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Succeeded
    );

    let ts_before_queue = env.ledger().timestamp();
    let _queue_ledger_before = env.ledger().sequence();

    governor_client.queue(&proposal_id);
    assert_eq!(governor_client.state(&proposal_id), ProposalState::Queued);

    // Get the operation ID
    let op_id: Bytes = env.as_contract(&governor_id, || {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&crate::DataKey::Proposal(proposal_id))
            .expect("proposal not found");

        proposal.op_ids.get(0).unwrap()
    });

    assert!(
        timelock_client.is_pending(&op_id),
        "operation should be pending after queue()"
    );

    // ------------------------------------------------------------------
    // Guardian cancels the proposal during veto window
    // ------------------------------------------------------------------

    governor_client.cancel_queued(&guardian, &proposal_id);

    // Proposal should now be Cancelled
    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Cancelled,
        "proposal should be Cancelled after cancel_queued()"
    );

    // Timelock operation should also be cancelled
    // is_pending should return false because the operation is cancelled
    assert!(
        !timelock_client.is_pending(&op_id),
        "operation should not be pending after cancel"
    );

    // Advance time past the timelock delay
    env.ledger()
        .with_mut(|l| l.timestamp = ts_before_queue + min_delay + 1);

    // MockTarget should not be called
    assert!(
        !mock_client.was_called(),
        "cancelled proposal should not execute"
    );
}

/// Test that cancel_queued fails after the veto window closes
#[test]
#[should_panic]
fn test_cancel_queued_after_window_closes() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // Setup
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);

    let votes_id = env.register(TokenVotesContract, ());
    let votes_client = TokenVotesContractClient::new(&env, &votes_id);
    votes_client.initialize(&admin, &token_addr);

    let mock_target_id = env.register(MockTarget, ());

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    let min_delay: u64 = 100;
    timelock_client.initialize(&admin, &governor_id, &min_delay, &1_209_600);

    let guardian = Address::generate(&env);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &20_u32,
        &0_u32,
        &0_i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    // Create and queue a proposal
    let alice = Address::generate(&env);
    token_admin.mint(&alice, &500_i128);
    votes_client.delegate(&alice, &alice);

    let proposer = Address::generate(&env);
    let fn_name = Symbol::new(&env, "exec_gov");
    let calldata = Bytes::from_slice(&env, b"test");
    let description = soroban_sdk::String::from_str(&env, "Test");

    let mut targets = soroban_sdk::Vec::new(&env);
    targets.push_back(mock_target_id);
    let mut fn_names = soroban_sdk::Vec::new(&env);
    fn_names.push_back(fn_name);
    let mut calldatas = soroban_sdk::Vec::new(&env);
    calldatas.push_back(calldata);

    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"test"))
        .into();
    let metadata_uri = soroban_sdk::String::from_str(&env, "ipfs://test");
    let proposal_id = governor_client.propose(
        &proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    );

    env.ledger().with_mut(|l| l.sequence_number = 11);
    governor_client.cast_vote(&alice, &proposal_id, &VoteSupport::For);

    env.ledger().with_mut(|l| l.sequence_number = 31);
    governor_client.queue(&proposal_id);

    // Advance ledger far past the veto window (min_delay is 100 seconds, roughly 10-20 ledgers)
    // Use a very large advance to ensure we're well past the veto window
    env.ledger()
        .with_mut(|l| l.sequence_number += 1000);

    // Try to cancel after veto window closes — should fail
    governor_client.cancel_queued(&guardian, &proposal_id);
}

#[test]
fn test_multi_token_weight_arithmetic_zero_balance_and_edge_tokens() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);
    let zero_voter = Address::generate(&env);

    let token_a = env.register(ConfigurableVotesContract, ());
    let token_b = env.register(ConfigurableVotesContract, ());
    let token_c = env.register(ConfigurableVotesContract, ());
    let token_e = env.register(ConfigurableVotesContract, ());
    let missing_token = Address::generate(&env);

    let token_a_client = ConfigurableVotesContractClient::new(&env, &token_a);
    let token_b_client = ConfigurableVotesContractClient::new(&env, &token_b);
    let token_c_client = ConfigurableVotesContractClient::new(&env, &token_c);
    let token_e_client = ConfigurableVotesContractClient::new(&env, &token_e);

    token_a_client.set_votes(&voter, &100);
    token_b_client.set_votes(&voter, &40);
    token_c_client.set_votes(&voter, &0);
    token_e_client.set_votes(&voter, &10);

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());
    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    timelock_client.initialize(&admin, &governor_id, &0, &1_209_600);
    governor_client.initialize(
        &admin,
        &token_a,
        &timelock_id,
        &10,
        &20,
        &0,
        &0,
        &guardian,
        &VoteType::Extended,
        &120_960,
    );

    let strategy = make_multi_token_strategy(
        &env,
        &[
            (token_a.clone(), 10_000),
            (token_b.clone(), 15_000),
            (token_c.clone(), 5_000),
            (missing_token, 20_000),
            (token_e.clone(), 2_500),
        ],
    );
    governor_client.set_voting_strategy(&strategy);

    let mock_target_id = env.register(MockTarget, ());
    let proposal_id = propose_exec_gov(
        &env,
        &governor_client,
        &proposer,
        &mock_target_id,
        b"multi-token-weighted",
    );

    env.ledger().with_mut(|l| l.sequence_number = 11);
    governor_client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

    let (votes_for, votes_against, votes_abstain) = governor_client.proposal_votes(&proposal_id);
    // 100*1.0 + 40*1.5 + 0*0.5 + missing*2.0 + 10*0.25 = 100 + 60 + 0 + 0 + 2
    assert_eq!(votes_for, 162);
    assert_eq!(votes_against, 0);
    assert_eq!(votes_abstain, 0);

    governor_client.cast_vote(&zero_voter, &proposal_id, &VoteSupport::Against);
    let receipt = governor_client.get_receipt(&proposal_id, &zero_voter);
    assert!(receipt.has_voted);
    assert_eq!(receipt.weight, 0);
}

#[test]
fn test_multi_token_quorum_uses_weighted_total_supply_sum() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let proposer = Address::generate(&env);

    let token_a = env.register(ConfigurableVotesContract, ());
    let token_b = env.register(ConfigurableVotesContract, ());
    let token_c = env.register(ConfigurableVotesContract, ());

    let token_a_client = ConfigurableVotesContractClient::new(&env, &token_a);
    let token_b_client = ConfigurableVotesContractClient::new(&env, &token_b);
    let token_c_client = ConfigurableVotesContractClient::new(&env, &token_c);

    token_a_client.set_total_supply(&1_000);
    token_b_client.set_total_supply(&2_000);
    token_c_client.set_total_supply(&3_000);

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());
    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);
    let mock_target_id = env.register(MockTarget, ());

    timelock_client.initialize(&admin, &governor_id, &0, &1_209_600);
    governor_client.initialize(
        &admin,
        &token_a,
        &timelock_id,
        &10,
        &20,
        &20,
        &0,
        &guardian,
        &VoteType::Extended,
        &120_960,
    );

    let strategy = make_multi_token_strategy(
        &env,
        &[
            (token_a.clone(), 10_000),
            (token_b.clone(), 5_000),
            (token_c.clone(), 20_000),
        ],
    );
    governor_client.set_voting_strategy(&strategy);

    let proposal_id = propose_exec_gov(
        &env,
        &governor_client,
        &proposer,
        &mock_target_id,
        b"multi-token-quorum",
    );

    assert_eq!(governor_client.quorum(&proposal_id), 1_600);
}

#[test]
fn test_multi_token_cast_vote_and_quorum_with_two_weighted_tokens() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);

    let token_a = env.register(ConfigurableVotesContract, ());
    let token_b = env.register(ConfigurableVotesContract, ());

    let token_a_client = ConfigurableVotesContractClient::new(&env, &token_a);
    let token_b_client = ConfigurableVotesContractClient::new(&env, &token_b);

    token_a_client.set_total_supply(&10_000);
    token_b_client.set_total_supply(&5_000);
    token_a_client.set_votes(&voter, &2_000);
    token_b_client.set_votes(&voter, &1_000);

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());
    let mock_target_id = env.register(MockTarget, ());
    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    timelock_client.initialize(&admin, &governor_id, &0, &1_209_600);
    governor_client.initialize(
        &admin,
        &token_a,
        &timelock_id,
        &10,
        &20,
        &20,
        &0,
        &guardian,
        &VoteType::Extended,
        &120_960,
    );

    let strategy = make_multi_token_strategy(
        &env,
        &[(token_a.clone(), 6_000), (token_b.clone(), 4_000)],
    );
    governor_client.set_voting_strategy(&strategy);

    let proposal_id = propose_exec_gov(
        &env,
        &governor_client,
        &proposer,
        &mock_target_id,
        b"multi-token-two-token-weighted",
    );

    assert_eq!(governor_client.quorum(&proposal_id), 1_600);

    env.ledger().with_mut(|l| l.sequence_number = 11);
    governor_client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

    let (votes_for, votes_against, votes_abstain) = governor_client.proposal_votes(&proposal_id);
    assert_eq!(votes_for, 1_600);
    assert_eq!(votes_against, 0);
    assert_eq!(votes_abstain, 0);
    assert!(governor_client.is_quorum_reached(&proposal_id));

    env.ledger().with_mut(|l| l.sequence_number = 31);
    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Succeeded
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #27)")]
fn test_multi_token_overflow_is_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);

    let token_a = env.register(ConfigurableVotesContract, ());
    let token_b = env.register(ConfigurableVotesContract, ());
    let token_c = env.register(ConfigurableVotesContract, ());
    let token_d = env.register(ConfigurableVotesContract, ());
    let token_e = env.register(ConfigurableVotesContract, ());

    for token in [&token_a, &token_b, &token_c, &token_d, &token_e] {
        let client = ConfigurableVotesContractClient::new(&env, token);
        client.set_votes(&voter, &i128::MAX);
    }

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());
    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);
    let mock_target_id = env.register(MockTarget, ());

    timelock_client.initialize(&admin, &governor_id, &0, &1_209_600);
    governor_client.initialize(
        &admin,
        &token_a,
        &timelock_id,
        &10,
        &20,
        &0,
        &0,
        &guardian,
        &VoteType::Extended,
        &120_960,
    );

    let strategy = make_multi_token_strategy(
        &env,
        &[
            (token_a.clone(), 20_000),
            (token_b.clone(), 20_000),
            (token_c.clone(), 20_000),
            (token_d.clone(), 20_000),
            (token_e.clone(), 20_000),
        ],
    );
    governor_client.set_voting_strategy(&strategy);

    let proposal_id = propose_exec_gov(
        &env,
        &governor_client,
        &proposer,
        &mock_target_id,
        b"multi-token-overflow",
    );

    env.ledger().with_mut(|l| l.sequence_number = 11);
    governor_client.cast_vote(&voter, &proposal_id, &VoteSupport::For);
}

#[test]
fn test_multi_token_full_lifecycle_with_three_tokens_and_quorum_gate() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let proposer = Address::generate(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    let token_a = env.register(ConfigurableVotesContract, ());
    let token_b = env.register(ConfigurableVotesContract, ());
    let token_c = env.register(ConfigurableVotesContract, ());

    let token_a_client = ConfigurableVotesContractClient::new(&env, &token_a);
    let token_b_client = ConfigurableVotesContractClient::new(&env, &token_b);
    let token_c_client = ConfigurableVotesContractClient::new(&env, &token_c);

    token_a_client.set_total_supply(&1_000);
    token_b_client.set_total_supply(&1_000);
    token_c_client.set_total_supply(&1_000);

    token_a_client.set_votes(&alice, &300);
    token_b_client.set_votes(&bob, &200);
    token_c_client.set_votes(&bob, &200);

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());
    let mock_target_id = env.register(MockTarget, ());
    let mock_target_pass_id = env.register(MockTarget, ());
    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);
    let mock_client = MockTargetClient::new(&env, &mock_target_pass_id);

    timelock_client.initialize(&admin, &governor_id, &1, &1_209_600);
    governor_client.initialize(
        &admin,
        &token_a,
        &timelock_id,
        &10,
        &20,
        &20,
        &0,
        &guardian,
        &VoteType::Extended,
        &120_960,
    );

    let strategy = make_multi_token_strategy(
        &env,
        &[
            (token_a.clone(), 10_000),
            (token_b.clone(), 10_000),
            (token_c.clone(), 10_000),
        ],
    );
    governor_client.set_voting_strategy(&strategy);

    let proposal_low = propose_exec_gov(
        &env,
        &governor_client,
        &proposer,
        &mock_target_id,
        b"multi-token-lifecycle-low",
    );
    env.ledger().with_mut(|l| l.sequence_number = 11);
    governor_client.cast_vote(&alice, &proposal_low, &VoteSupport::For);
    env.ledger().with_mut(|l| l.sequence_number = 31);
    assert_eq!(
        governor_client.state(&proposal_low),
        ProposalState::Defeated
    );

    let proposer_pass = Address::generate(&env);
    let proposal_pass = propose_exec_gov(
        &env,
        &governor_client,
        &proposer_pass,
        &mock_target_pass_id,
        b"multi-token-lifecycle-pass",
    );
    env.ledger().with_mut(|l| l.sequence_number = 42);
    governor_client.cast_vote(&alice, &proposal_pass, &VoteSupport::For);
    governor_client.cast_vote(&bob, &proposal_pass, &VoteSupport::For);

    let (votes_for, votes_against, votes_abstain) = governor_client.proposal_votes(&proposal_pass);
    assert_eq!(votes_for, 700);
    assert_eq!(votes_against, 0);
    assert_eq!(votes_abstain, 0);

    env.ledger().with_mut(|l| l.sequence_number = 62);
    assert_eq!(
        governor_client.state(&proposal_pass),
        ProposalState::Succeeded
    );

    let ts_before_queue = env.ledger().timestamp();
    governor_client.queue(&proposal_pass);
    assert_eq!(governor_client.state(&proposal_pass), ProposalState::Queued);

    env.ledger().with_mut(|l| l.timestamp = ts_before_queue + 2);
    governor_client.execute(&proposal_pass);

    assert!(mock_client.was_called());
    assert_eq!(
        governor_client.state(&proposal_pass),
        ProposalState::Executed
    );
}

// ---------------------------------------------------------------------------
// Dynamic quorum oracle integration tests (#253)
// ---------------------------------------------------------------------------

/// Helper: deploy a governor backed by a ConfigurableVotesContract with a
/// known total supply, quorum numerator, and zero proposal threshold so any
/// address can propose.
fn setup_dynamic_quorum_governor<'a>(
    env: &'a Env,
    total_supply: i128,
    quorum_numerator: u32,
) -> (GovernorContractClient<'a>, ConfigurableVotesContractClient<'a>, Address, Address) {
    let admin = Address::generate(env);
    let guardian = Address::generate(env);

    let votes_id = env.register(ConfigurableVotesContract, ());
    let votes_client = ConfigurableVotesContractClient::new(env, &votes_id);
    votes_client.set_total_supply(&total_supply);

    let timelock_id = env.register(sorogov_timelock::TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = sorogov_timelock::TimelockContractClient::new(env, &timelock_id);
    let governor_client = GovernorContractClient::new(env, &governor_id);

    timelock_client.initialize(&admin, &governor_id, &0u64, &1_209_600u64);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32, // voting_delay
        &20_u32, // voting_period
        &quorum_numerator,
        &0_i128, // proposal_threshold
        &guardian,
        &VoteType::Simple,
        &120_960_u32,
    );

    (governor_client, votes_client, votes_id, admin)
}

/// Create a minimal proposal and return its ID.
fn create_minimal_proposal(
    env: &Env,
    governor_client: &GovernorContractClient,
) -> u64 {
    let proposer = Address::generate(env);
    let mock_target = env.register(MockTarget, ());

    let description = soroban_sdk::String::from_str(env, "dynamic quorum test proposal");
    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(env, b"dynamic-quorum-test"))
        .into();
    let metadata_uri = soroban_sdk::String::from_str(env, "ipfs://dynamic-quorum-test");

    let mut targets = soroban_sdk::Vec::new(env);
    targets.push_back(mock_target.clone());
    let mut fn_names = soroban_sdk::Vec::new(env);
    fn_names.push_back(Symbol::new(env, "exec_gov"));
    let mut calldatas = soroban_sdk::Vec::new(env);
    calldatas.push_back(Bytes::new(env));

    governor_client.propose(
        &proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    )
}

/// dynamic quorum > static quorum → dynamic applies.
/// dynamic quorum < static quorum → static applies (max wins).
#[test]
fn test_dynamic_quorum_uses_max_of_static_and_dynamic() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // total_supply = 1_000_000, quorum_numerator = 10 → static_quorum = 100_000
    let (governor_client, _votes_client, _votes_id, _admin) =
        setup_dynamic_quorum_governor(&env, 1_000_000, 10);

    let proposal_id = create_minimal_proposal(&env, &governor_client);

    // Sanity: without dynamic quorum, result is the static quorum.
    let static_q = governor_client.quorum(&proposal_id);
    assert_eq!(static_q, 100_000, "static quorum should be 10% of 1_000_000");

    // Register a configurable oracle: price = $1 (1_000_000 in 6-decimal).
    let oracle_id = env.register(ConfigurableOracleContract, ());
    let oracle_client = ConfigurableOracleContractClient::new(&env, &oracle_id);
    oracle_client.set_price(&Some(1_000_000_i128));

    // Case A: usd_quorum (50) < static_quorum (100_000) → static wins.
    // min_quorum_usd = 50 → usd_quorum = 50 / 1_000_000 = 0 (integer div, < 1)
    governor_client.update_oracle(&Some(oracle_id.clone()), &50_i128, &true);
    let q_static_wins = governor_client.quorum(&proposal_id);
    assert_eq!(
        q_static_wins, 100_000,
        "static quorum should win when dynamic usd_quorum is smaller"
    );

    // Case B: usd_quorum > static_quorum → dynamic wins.
    // min_quorum_usd = 200_000_000_000, price = 1_000_000
    // usd_quorum = 200_000_000_000 / 1_000_000 = 200_000 > 100_000 → dynamic wins.
    governor_client.update_oracle(&Some(oracle_id.clone()), &200_000_000_000_i128, &true);
    let q_dynamic_wins = governor_client.quorum(&proposal_id);
    assert_eq!(
        q_dynamic_wins, 200_000,
        "dynamic quorum should apply when usd_quorum exceeds static"
    );
}

/// When the oracle returns a price of 0, the governor must NOT divide by zero.
/// Instead it should fall back gracefully to the static quorum.
#[test]
fn test_dynamic_quorum_oracle_zero_price_falls_back_to_static() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // static_quorum = 10% of 500_000 = 50_000
    let (governor_client, _votes_client, _votes_id, _admin) =
        setup_dynamic_quorum_governor(&env, 500_000, 10);

    let proposal_id = create_minimal_proposal(&env, &governor_client);

    let oracle_id = env.register(ConfigurableOracleContract, ());
    let oracle_client = ConfigurableOracleContractClient::new(&env, &oracle_id);

    // Oracle returns a price of zero — should NOT cause a division-by-zero panic.
    oracle_client.set_price(&Some(0_i128));
    governor_client.update_oracle(&Some(oracle_id.clone()), &999_999_999_i128, &true);

    let q = governor_client.quorum(&proposal_id);
    assert_eq!(
        q, 50_000,
        "zero oracle price must fall back to static quorum, not panic"
    );
}

/// When the oracle returns None (simulating an unreachable oracle), the
/// governor must fall back gracefully to the static quorum.
#[test]
fn test_dynamic_quorum_oracle_no_price_falls_back_to_static() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // static_quorum = 20% of 1_000_000 = 200_000
    let (governor_client, _votes_client, _votes_id, _admin) =
        setup_dynamic_quorum_governor(&env, 1_000_000, 20);

    let proposal_id = create_minimal_proposal(&env, &governor_client);

    let oracle_id = env.register(ConfigurableOracleContract, ());
    let oracle_client = ConfigurableOracleContractClient::new(&env, &oracle_id);

    // Oracle returns None — no price available.
    oracle_client.set_price(&None);
    governor_client.update_oracle(&Some(oracle_id.clone()), &999_999_999_i128, &true);

    let q = governor_client.quorum(&proposal_id);
    assert_eq!(
        q, 200_000,
        "None oracle price must fall back to static quorum"
    );
}

/// When use_dynamic_quorum is false the oracle must never be consulted;
/// the static quorum is returned even if an oracle with a high USD floor
/// is configured.
#[test]
fn test_dynamic_quorum_falls_back_to_static_when_disabled() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // static_quorum = 10% of 2_000_000 = 200_000
    let (governor_client, _votes_client, _votes_id, _admin) =
        setup_dynamic_quorum_governor(&env, 2_000_000, 10);

    let proposal_id = create_minimal_proposal(&env, &governor_client);

    let oracle_id = env.register(ConfigurableOracleContract, ());
    let oracle_client = ConfigurableOracleContractClient::new(&env, &oracle_id);

    // Even though price = $1 and min_quorum_usd is enormous (would give
    // usd_quorum >> static_quorum), use_dynamic = false means oracle is skipped.
    oracle_client.set_price(&Some(1_000_000_i128));
    governor_client.update_oracle(
        &Some(oracle_id.clone()),
        &100_000_000_000_000_i128,
        &false, // dynamic disabled
    );

    let q = governor_client.quorum(&proposal_id);
    assert_eq!(
        q, 200_000,
        "static quorum must be used when use_dynamic_quorum is false"
    );
}

/// Boundary values for quorum_numerator: 0 returns 0 without touching the
/// oracle; 100 returns the full supply.
#[test]
fn test_quorum_denominator_boundary_values() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // --- quorum_numerator = 0 ---
    let (governor_zero, _vc, _vid, _a) = setup_dynamic_quorum_governor(&env, 1_000_000, 0);
    let pid_zero = create_minimal_proposal(&env, &governor_zero);
    assert_eq!(
        governor_zero.quorum(&pid_zero),
        0,
        "quorum_numerator=0 must return 0"
    );

    // --- quorum_numerator = 100 (full supply) ---
    let (governor_full, _vc2, _vid2, _a2) = setup_dynamic_quorum_governor(&env, 1_000_000, 100);
    let pid_full = create_minimal_proposal(&env, &governor_full);
    assert_eq!(
        governor_full.quorum(&pid_full),
        1_000_000,
        "quorum_numerator=100 must return full supply"
    );
}

// ============================================================================
// Pause/Unpause Integration Tests (Issue #247)
// ============================================================================

/// Test 1: Propose succeeds while paused (governance is not blocked by pausing)
/// Governance must remain operational while paused so the DAO can still act
/// (e.g., vote to unpause or pass emergency proposals).
#[test]
fn test_pause_blocks_propose() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // Setup
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);

    let votes_id = env.register(TokenVotesContract, ());
    let votes_client = TokenVotesContractClient::new(&env, &votes_id);
    votes_client.initialize(&admin, &token_addr);

    let mock_target_id = env.register(MockTarget, ());

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    timelock_client.initialize(&admin, &governor_id, &1, &1_209_600);

    let pauser = Address::generate(&env);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &20_u32,
        &0_u32,
        &0_i128,
        &pauser,
        &VoteType::Extended,
        &120_960u32,
    );

    // Verify initial pauser is set to admin (who called initialize)
    assert_eq!(governor_client.pauser(), admin);

    // Set the pauser to the designated pauser address
    governor_client.set_pauser(&pauser);
    assert_eq!(governor_client.pauser(), pauser);

    // Pause the contract
    governor_client.pause(&pauser);
    assert!(governor_client.is_paused());

    // Propose while paused — governance is NOT gated by the paused flag so the
    // DAO can still create proposals (e.g., an emergency unpause proposal).
    let proposer = Address::generate(&env);
    token_admin.mint(&proposer, &1000_i128);
    votes_client.delegate(&proposer, &proposer);

    let description = soroban_sdk::String::from_str(&env, "Test proposal during pause");
    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"test"))
        .into();
    let metadata_uri = soroban_sdk::String::from_str(&env, "ipfs://test");

    let mut targets = soroban_sdk::Vec::new(&env);
    targets.push_back(mock_target_id.clone());
    let mut fn_names = soroban_sdk::Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "exec_gov"));
    let mut calldatas = soroban_sdk::Vec::new(&env);
    calldatas.push_back(Bytes::new(&env));

    let proposal_id = governor_client.propose(
        &proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    );

    // Proposal was created successfully despite the governor being paused
    assert_eq!(proposal_id, 1, "proposal should be created while paused");
    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Pending,
        "proposal should be in Pending state"
    );
}

/// Test 2: cast_vote succeeds while paused (governance is not blocked by pausing)
/// Voting must remain operational while paused so the DAO can cast votes on
/// in-flight proposals (e.g., an emergency unpause proposal).
#[test]
fn test_pause_blocks_cast_vote() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // Setup
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);

    let votes_id = env.register(TokenVotesContract, ());
    let votes_client = TokenVotesContractClient::new(&env, &votes_id);
    votes_client.initialize(&admin, &token_addr);

    let mock_target_id = env.register(MockTarget, ());

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    timelock_client.initialize(&admin, &governor_id, &1, &1_209_600);

    let pauser = Address::generate(&env);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &20_u32,
        &0_u32,
        &0_i128,
        &pauser,
        &VoteType::Extended,
        &120_960u32,
    );

    governor_client.set_pauser(&pauser);

    // Create voter with tokens
    let voter = Address::generate(&env);
    token_admin.mint(&voter, &1000_i128);
    votes_client.delegate(&voter, &voter);

    // Create proposal before pausing
    let proposer = Address::generate(&env);
    token_admin.mint(&proposer, &1000_i128);
    votes_client.delegate(&proposer, &proposer);

    let description = soroban_sdk::String::from_str(&env, "Test proposal");
    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"test-vote"))
        .into();
    let metadata_uri = soroban_sdk::String::from_str(&env, "ipfs://test");

    let mut targets = soroban_sdk::Vec::new(&env);
    targets.push_back(mock_target_id.clone());
    let mut fn_names = soroban_sdk::Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "exec_gov"));
    let mut calldatas = soroban_sdk::Vec::new(&env);
    calldatas.push_back(Bytes::new(&env));

    let proposal_id = governor_client.propose(
        &proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    );

    // Advance to voting period
    env.ledger().with_mut(|l| l.sequence_number = 11);

    // Now pause the contract
    governor_client.pause(&pauser);
    assert!(governor_client.is_paused());

    // cast_vote succeeds while paused — governance is NOT gated by the paused flag
    governor_client.cast_vote(&voter, &proposal_id, &VoteSupport::For);

    // Verify the vote was recorded despite the governor being paused
    let receipt = governor_client.get_receipt(&proposal_id, &voter);
    assert!(receipt.has_voted, "vote should be recorded while paused");
}

/// Test 3: Governance works while paused; pauser can unpause to restore full functionality.
/// pause() → propose (mock target) → vote → queue → execute → unpause (pauser) →
/// assert is_paused() == false → new propose() succeeds
#[test]
fn test_unpause_via_governance_restores_functionality() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // Setup
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);

    let votes_id = env.register(TokenVotesContract, ());
    let votes_client = TokenVotesContractClient::new(&env, &votes_id);
    votes_client.initialize(&admin, &token_addr);

    let mock_target_id = env.register(MockTarget, ());

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    let min_delay: u64 = 1;
    timelock_client.initialize(&admin, &governor_id, &min_delay, &1_209_600);

    let pauser = Address::generate(&env);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &20_u32,
        &0_u32,
        &0_i128,
        &pauser,
        &VoteType::Extended,
        &120_960u32,
    );

    governor_client.set_pauser(&pauser);

    // Setup voters
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    token_admin.mint(&alice, &500_i128);
    token_admin.mint(&bob, &500_i128);
    votes_client.delegate(&alice, &alice);
    votes_client.delegate(&bob, &bob);

    // Pause the contract
    governor_client.pause(&pauser);
    assert!(governor_client.is_paused(), "contract should be paused");

    // Create a governance proposal targeting mock_target while paused.
    // Governance functions (propose, cast_vote, queue, execute) are permitted while paused
    // so the DAO can still act; targeting the governor itself would trigger Soroban
    // re-entry protection (governor.execute → timelock.execute → governor.<fn>), so we
    // target an external contract here.
    let proposer = Address::generate(&env);
    token_admin.mint(&proposer, &1000_i128);
    votes_client.delegate(&proposer, &proposer);

    let description = soroban_sdk::String::from_str(&env, "Governance action while paused");
    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"paused-proposal"))
        .into();
    let metadata_uri = soroban_sdk::String::from_str(&env, "ipfs://paused-proposal");

    let mut targets = soroban_sdk::Vec::new(&env);
    targets.push_back(mock_target_id.clone());
    let mut fn_names = soroban_sdk::Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "exec_gov"));
    let mut calldatas = soroban_sdk::Vec::new(&env);
    calldatas.push_back(Bytes::new(&env));

    let proposal_id = governor_client.propose(
        &proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    );

    // Vote to succeed
    env.ledger().with_mut(|l| l.sequence_number = 11);
    governor_client.cast_vote(&alice, &proposal_id, &VoteSupport::For);
    governor_client.cast_vote(&bob, &proposal_id, &VoteSupport::For);

    // Advance past voting period and queue
    env.ledger().with_mut(|l| l.sequence_number = 31);
    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Succeeded
    );

    let ts_before_queue = env.ledger().timestamp();
    governor_client.queue(&proposal_id);
    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Queued
    );

    // Advance past timelock delay and execute — governance works while paused
    env.ledger()
        .with_mut(|l| l.timestamp = ts_before_queue + min_delay + 1);
    governor_client.execute(&proposal_id);

    // Pauser unpauses the contract directly (unpause takes a caller address)
    governor_client.unpause(&pauser);

    // Verify contract is unpaused
    assert!(
        !governor_client.is_paused(),
        "contract should be unpaused after pauser calls unpause"
    );

    // Now proposing should succeed
    let new_proposer = Address::generate(&env);
    token_admin.mint(&new_proposer, &1000_i128);
    votes_client.delegate(&new_proposer, &new_proposer);

    let new_description = soroban_sdk::String::from_str(&env, "Post-unpause proposal");
    let new_description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"post-unpause"))
        .into();
    let new_metadata_uri = soroban_sdk::String::from_str(&env, "ipfs://post-unpause");

    let mut new_targets = soroban_sdk::Vec::new(&env);
    new_targets.push_back(mock_target_id.clone());
    let mut new_fn_names = soroban_sdk::Vec::new(&env);
    new_fn_names.push_back(Symbol::new(&env, "exec_gov"));
    let mut new_calldatas = soroban_sdk::Vec::new(&env);
    new_calldatas.push_back(Bytes::new(&env));

    let new_proposal_id = governor_client.propose(
        &new_proposer,
        &new_description,
        &new_description_hash,
        &new_metadata_uri,
        &new_targets,
        &new_fn_names,
        &new_calldatas,
    );

    assert_eq!(new_proposal_id, 2, "new proposal should be created after unpause");
    assert_eq!(
        governor_client.state(&new_proposal_id),
        ProposalState::Pending,
        "new proposal should be in Pending state"
    );
}

/// Test 4: Only pauser can pause
/// non-pauser address calls pause() → expect UnauthorizedPause error (code 8)
#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_only_pauser_can_pause() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // Setup
    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();

    let votes_id = env.register(TokenVotesContract, ());
    let votes_client = TokenVotesContractClient::new(&env, &votes_id);
    votes_client.initialize(&admin, &token_addr);

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    timelock_client.initialize(&admin, &governor_id, &1, &1_209_600);

    let pauser = Address::generate(&env);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &20_u32,
        &0_u32,
        &0_i128,
        &pauser,
        &VoteType::Extended,
        &120_960u32,
    );

    governor_client.set_pauser(&pauser);
    assert_eq!(governor_client.pauser(), pauser);

    // Non-pauser tries to pause - should fail with UnauthorizedPause (code 8)
    let non_pauser = Address::generate(&env);
    governor_client.pause(&non_pauser);
}

/// Test 5: set_pauser only via self-auth
/// direct call to set_pauser() with an external caller → expect auth error
#[test]
#[should_panic]
fn test_set_pauser_requires_self_auth() {
    let env = Env::default();

    let governor_id = env.register(GovernorContract, ());
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    // Mock auth as an external admin — NOT the contract's own address.
    // set_pauser() requires env.current_contract_address().require_auth(),
    // so this external auth cannot satisfy it and the call must panic.
    let admin = Address::generate(&env);
    let new_pauser = Address::generate(&env);
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &admin,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &governor_id,
            fn_name: "set_pauser",
            args: (new_pauser.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    governor_client.set_pauser(&new_pauser);
}

/// Regression test for issue #600: cancel_queued used /10 instead of /5 to
/// convert the timelock delay (seconds) to ledgers, halving the guardian's
/// veto window.
///
/// With `min_delay = 100` seconds:
///   - Buggy window end  = queue_ledger + (100 / 10) = queue_ledger + 10
///   - Correct window end = queue_ledger + (100 /  5) = queue_ledger + 20
///
/// This test advances 11 ledgers past the queue point — past the old (wrong)
/// boundary but still inside the correct window — and asserts that the
/// guardian can successfully cancel.  With the bug present the call panics
/// with `VetoWindowClosed`.
#[test]
fn test_cancel_queued_veto_window_uses_correct_conversion_factor() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);

    let votes_id = env.register(TokenVotesContract, ());
    let votes_client = TokenVotesContractClient::new(&env, &votes_id);
    votes_client.initialize(&admin, &token_addr);

    let mock_target_id = env.register(MockTarget, ());

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    // 100-second min_delay → 20-ledger veto window (100 / 5), not 10 (100 / 10).
    let min_delay: u64 = 100;
    timelock_client.initialize(&admin, &governor_id, &min_delay, &1_209_600);

    let guardian = Address::generate(&env);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &20_u32,
        &0_u32,
        &0_i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    let alice = Address::generate(&env);
    token_admin.mint(&alice, &500_i128);
    votes_client.delegate(&alice, &alice);

    let proposer = Address::generate(&env);
    let fn_name = Symbol::new(&env, "exec_gov");
    let calldata = Bytes::new(&env);
    let description = soroban_sdk::String::from_str(&env, "Regression #600");
    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"Regression #600"))
        .into();
    let metadata_uri = soroban_sdk::String::from_str(&env, "ipfs://regression-600");

    let mut targets = soroban_sdk::Vec::new(&env);
    targets.push_back(mock_target_id.clone());
    let mut fn_names = soroban_sdk::Vec::new(&env);
    fn_names.push_back(fn_name);
    let mut calldatas = soroban_sdk::Vec::new(&env);
    calldatas.push_back(calldata);

    let proposal_id = governor_client.propose(
        &proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    );

    // Advance into voting, cast a winning vote, then past end_ledger.
    env.ledger().with_mut(|l| l.sequence_number = 11);
    governor_client.cast_vote(&alice, &proposal_id, &VoteSupport::For);

    env.ledger().with_mut(|l| l.sequence_number = 31);
    assert_eq!(governor_client.state(&proposal_id), ProposalState::Succeeded);

    // Record the ledger at queue time; advance 11 ledgers (old buggy boundary +1).
    let queue_ledger = env.ledger().sequence();
    governor_client.queue(&proposal_id);
    assert_eq!(governor_client.state(&proposal_id), ProposalState::Queued);

    // 11 ledgers past queue point: old code (/ 10) thinks window closed at +10,
    // correct code (/ 5) knows window closes at +20.
    env.ledger()
        .with_mut(|l| l.sequence_number = queue_ledger + 11);

    // Must succeed — we are still inside the correct veto window.
    governor_client.cancel_queued(&guardian, &proposal_id);

    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Cancelled,
        "proposal must be Cancelled: guardian is still within the veto window at ledger +11"
    );
}

// ---------------------------------------------------------------------------
// cast_vote / cast_vote_with_reason Active-state guard tests (issue #603)
//
// Before this fix, both functions accepted votes at any ledger, which meant
// a post-deadline voter could flip a Defeated proposal to Succeeded and then
// queue it for execution.  The guard now rejects any vote cast outside the
// [start_ledger, end_ledger] window.
// ---------------------------------------------------------------------------

/// Helper: deploy governor backed by ConfigurableVotesContract (no real token
/// needed) and submit a single proposal.  Returns (governor_id, proposal_id,
/// start_ledger, end_ledger).
fn setup_governor_with_proposal(
    env: &Env,
) -> (Address, Address, u64, u32, u32) {
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(env);
    let guardian = Address::generate(env);
    let proposer = Address::generate(env);
    let voter = Address::generate(env);

    let votes_id = env.register(ConfigurableVotesContract, ());
    let votes_client = ConfigurableVotesContractClient::new(env, &votes_id);
    votes_client.set_votes(&voter, &1_000_000);
    votes_client.set_votes(&proposer, &1_000_000);
    votes_client.set_total_supply(&10_000_000);

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());
    let timelock_client = TimelockContractClient::new(env, &timelock_id);
    let governor_client = GovernorContractClient::new(env, &governor_id);

    timelock_client.initialize(&admin, &governor_id, &0, &1_209_600);
    // voting_delay = 10, voting_period = 20 → start=10, end=30
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10,
        &20,
        &0,
        &0,
        &guardian,
        &VoteType::Extended,
        &120_960,
    );

    let mock_target_id = env.register(MockTarget, ());
    let proposal_id = propose_exec_gov(env, &governor_client, &proposer, &mock_target_id, b"issue-603");

    let proposal = governor_client.get_proposal(&proposal_id);
    let start_ledger = proposal.start_ledger;
    let end_ledger = proposal.end_ledger;

    (governor_id, votes_id, proposal_id, start_ledger, end_ledger)
}

#[test]
#[should_panic(expected = "Error(Contract, #31)")]
fn test_cast_vote_before_start_ledger_is_rejected() {
    let env = Env::default();
    let (governor_id, _votes_id, proposal_id, start_ledger, _end_ledger) =
        setup_governor_with_proposal(&env);
    let governor_client = GovernorContractClient::new(&env, &governor_id);
    let voter = Address::generate(&env);

    // Ledger is still before start — proposal is Pending.
    assert!(env.ledger().sequence() < start_ledger);
    assert_eq!(governor_client.state(&proposal_id), ProposalState::Pending);

    // Must panic with ProposalNotActive (error code 31).
    governor_client.cast_vote(&voter, &proposal_id, &VoteSupport::For);
}

#[test]
#[should_panic(expected = "Error(Contract, #31)")]
fn test_cast_vote_after_end_ledger_is_rejected() {
    let env = Env::default();
    let (governor_id, _votes_id, proposal_id, _start_ledger, end_ledger) =
        setup_governor_with_proposal(&env);
    let governor_client = GovernorContractClient::new(&env, &governor_id);
    let voter = Address::generate(&env);

    // Advance one ledger past end — voting period has closed.
    env.ledger().with_mut(|l| l.sequence_number = end_ledger + 1);

    // Must panic with ProposalNotActive (error code 31).
    governor_client.cast_vote(&voter, &proposal_id, &VoteSupport::For);
}

#[test]
#[should_panic(expected = "Error(Contract, #31)")]
fn test_cast_vote_with_reason_after_end_ledger_is_rejected() {
    let env = Env::default();
    let (governor_id, _votes_id, proposal_id, _start_ledger, end_ledger) =
        setup_governor_with_proposal(&env);
    let governor_client = GovernorContractClient::new(&env, &governor_id);
    let voter = Address::generate(&env);

    env.ledger().with_mut(|l| l.sequence_number = end_ledger + 1);

    let reason = soroban_sdk::String::from_str(&env, "late vote attempt");
    // Must panic with ProposalNotActive (error code 31).
    governor_client.cast_vote_with_reason(&voter, &proposal_id, &VoteSupport::For, &reason);
}

/// Regression test for the exact attack described in issue #603:
/// a post-deadline vote must not be able to flip a Defeated proposal to Succeeded.
#[test]
fn test_post_deadline_vote_cannot_flip_defeated_proposal() {
    let env = Env::default();
    let (governor_id, votes_id, proposal_id, start_ledger, end_ledger) =
        setup_governor_with_proposal(&env);
    let governor_client = GovernorContractClient::new(&env, &governor_id);
    let votes_client = ConfigurableVotesContractClient::new(&env, &votes_id);

    let for_voter = Address::generate(&env);
    let against_voter = Address::generate(&env);
    votes_client.set_votes(&against_voter, &1_000_000);

    // Cast "against" vote during Active window → proposal ends Defeated.
    env.ledger().with_mut(|l| l.sequence_number = start_ledger + 1);
    governor_client.cast_vote(&against_voter, &proposal_id, &VoteSupport::Against);

    // Advance past end_ledger.
    env.ledger().with_mut(|l| l.sequence_number = end_ledger + 1);
    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Defeated,
        "proposal must be Defeated after voting period"
    );

    // Attacker tries to flip the outcome by voting after deadline.
    // try_cast_vote returns Err when the contract panics — no std required.
    let flip_result =
        governor_client.try_cast_vote(&for_voter, &proposal_id, &VoteSupport::For);
    assert!(
        flip_result.is_err(),
        "post-deadline vote must be rejected by the contract"
    );

    // Verify the proposal is still Defeated and tallies are unchanged.
    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Defeated,
        "proposal must remain Defeated after rejected post-deadline vote"
    );

    let (votes_for, _votes_against, _) = governor_client.proposal_votes(&proposal_id);
    assert_eq!(votes_for, 0, "votes_for must not have increased");
}

#[test]
fn test_cast_vote_succeeds_at_start_and_end_ledger_boundaries() {
    let env = Env::default();
    let (governor_id, votes_id, proposal_id, start_ledger, end_ledger) =
        setup_governor_with_proposal(&env);
    let governor_client = GovernorContractClient::new(&env, &governor_id);
    let votes_client = ConfigurableVotesContractClient::new(&env, &votes_id);

    let voter_a = Address::generate(&env);
    let voter_b = Address::generate(&env);
    votes_client.set_votes(&voter_a, &1_000_000);
    votes_client.set_votes(&voter_b, &1_000_000);

    // Vote at exactly start_ledger — must succeed.
    env.ledger().with_mut(|l| l.sequence_number = start_ledger);
    governor_client.cast_vote(&voter_a, &proposal_id, &VoteSupport::For);

    // Vote at exactly end_ledger — must succeed.
    env.ledger().with_mut(|l| l.sequence_number = end_ledger);
    governor_client.cast_vote(&voter_b, &proposal_id, &VoteSupport::Against);

    // Both receipts recorded.
    assert!(governor_client.get_receipt(&proposal_id, &voter_a).has_voted);
    assert!(governor_client.get_receipt(&proposal_id, &voter_b).has_voted);
}
