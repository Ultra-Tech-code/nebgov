//! Integration tests for governor-factory contract deployment.
//!
//! These tests verify that the factory can deploy a complete governance stack
//! (Governor + Timelock + Token-Votes) and that the deployed contracts are
//! fully functional and can execute a complete proposal lifecycle.

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events, Ledger as _},
    token, Address, Bytes, Env, Symbol,
};

use sorogov_governor::{GovernorContract, GovernorContractClient, ProposalState, VoteSupport};
use sorogov_timelock::{TimelockContract, TimelockContractClient};
use sorogov_token_votes::{TokenVotesContract, TokenVotesContractClient};

// Import the WASM binaries for the contracts we want to deploy.
mod wasm {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/sorogov_governor.wasm");
}

mod timelock_wasm {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/sorogov_timelock.wasm");
}

mod token_votes_wasm {
    soroban_sdk::contractimport!(
        file = "../../target/wasm32v1-none/release/sorogov_token_votes.wasm"
    );
}

// ---------------------------------------------------------------------------
// MockTarget — a minimal contract to verify proposal execution.
// ---------------------------------------------------------------------------

#[contract]
pub struct MockTarget;

#[contractimpl]
impl MockTarget {
    /// Called by the timelock when the proposal executes.
    pub fn exec_gov(env: Env) {
        env.storage()
            .instance()
            .set(&soroban_sdk::symbol_short!("called"), &true);
    }

    /// Returns whether `exec_gov` has been called.
    pub fn was_called(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&soroban_sdk::symbol_short!("called"))
            .unwrap_or(false)
    }
}

/// Helper: upload WASMs to the test environment and return their hashes.
fn upload_wasms(env: &Env) -> (BytesN<32>, BytesN<32>, BytesN<32>) {
    let governor_hash = env.deployer().upload_contract_wasm(wasm::WASM);
    let timelock_hash = env.deployer().upload_contract_wasm(timelock_wasm::WASM);
    let token_votes_hash = env.deployer().upload_contract_wasm(token_votes_wasm::WASM);
    (governor_hash, timelock_hash, token_votes_hash)
}

// ---------------------------------------------------------------------------
// Integration Test: Factory deploy produces working governor
// ---------------------------------------------------------------------------

#[test]
fn factory_deploy_produces_working_governor() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // ------------------------------------------------------------------
    // 1. Setup: Register contracts and upload WASMs
    // ------------------------------------------------------------------

    env.register(GovernorContract, ());
    env.register(TimelockContract, ());
    env.register(TokenVotesContract, ());

    let (governor_hash, timelock_hash, token_votes_hash) = upload_wasms(&env);

    let admin = Address::generate(&env);
    let deployer = Address::generate(&env);

    // Create underlying SEP-41 governance token
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_addr = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_addr);

    // ------------------------------------------------------------------
    // 2. Initialize factory
    // ------------------------------------------------------------------

    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);

    factory.initialize(&admin, &governor_hash, &timelock_hash, &token_votes_hash);
    assert_eq!(factory.governor_count(), 0);

    // ------------------------------------------------------------------
    // 3. Deploy governance stack via factory
    // ------------------------------------------------------------------

    let voting_delay = 10u32;
    let voting_period = 20u32;
    let quorum_numerator = 0u32; // Simple majority test
    let proposal_threshold = 0i128;
    let timelock_delay = 1u64; // 1 second for fast testing
    let guardian = admin.clone();
    let vote_type = 1u32;
    let proposal_grace_period = 120_960u32;

    let deploy_id = factory.deploy(
        &deployer,
        &token_addr,
        &voting_delay,
        &voting_period,
        &quorum_numerator,
        &proposal_threshold,
        &timelock_delay,
        &guardian,
        &vote_type,
        &proposal_grace_period,
    );

    // ------------------------------------------------------------------
    // 4. Verify deployment: addresses are non-zero and distinct
    // ------------------------------------------------------------------

    assert_eq!(deploy_id, 1, "first deployment should have ID 1");
    assert_eq!(
        factory.governor_count(),
        1,
        "factory should track one deployment"
    );

    let entry = factory.get_governor(&deploy_id);
    assert_eq!(entry.id, deploy_id);
    assert_eq!(entry.deployer, deployer);

    // All addresses must be distinct and non-zero (not the factory address)
    assert_ne!(
        entry.governor, factory_id,
        "governor address must not be factory"
    );
    assert_ne!(
        entry.timelock, factory_id,
        "timelock address must not be factory"
    );
    assert_ne!(
        entry.token, factory_id,
        "token-votes address must not be factory"
    );
    assert_ne!(
        entry.governor, entry.timelock,
        "governor and timelock must be distinct"
    );
    assert_ne!(
        entry.governor, entry.token,
        "governor and token-votes must be distinct"
    );
    assert_ne!(
        entry.timelock, entry.token,
        "timelock and token-votes must be distinct"
    );

    // ------------------------------------------------------------------
    // 5. Verify governor is initialized correctly
    // ------------------------------------------------------------------

    let governor_client = GovernorContractClient::new(&env, &entry.governor);
    assert_eq!(governor_client.voting_delay(), voting_delay);
    assert_eq!(governor_client.voting_period(), voting_period);
    assert_eq!(governor_client.proposal_threshold(), proposal_threshold);

    // ------------------------------------------------------------------
    // 6. Verify timelock is initialized correctly
    // ------------------------------------------------------------------

    let timelock_client = TimelockContractClient::new(&env, &entry.timelock);
    assert_eq!(
        timelock_client.min_delay(),
        timelock_delay,
        "timelock delay must match"
    );
    assert_eq!(
        timelock_client.governor(),
        entry.governor,
        "timelock must reference governor"
    );

    // ------------------------------------------------------------------
    // 7. Verify token-votes is initialized correctly
    // ------------------------------------------------------------------

    let votes_client = TokenVotesContractClient::new(&env, &entry.token);
    assert_eq!(
        votes_client.token(),
        token_addr,
        "token-votes must reference underlying token"
    );

    // ------------------------------------------------------------------
    // 8. Run full proposal lifecycle through factory-deployed governor
    // ------------------------------------------------------------------

    // Setup voters
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    token_admin.mint(&alice, &500_i128);
    token_admin.mint(&bob, &500_i128);

    votes_client.delegate(&alice, &alice);
    votes_client.delegate(&bob, &bob);

    // Deploy mock target for proposal execution
    let mock_target_id = env.register(MockTarget, ());
    let mock_client = MockTargetClient::new(&env, &mock_target_id);

    // Create proposal
    let proposer = Address::generate(&env);
    let fn_name = Symbol::new(&env, "exec_gov");
    let calldata = Bytes::new(&env);
    let description = soroban_sdk::String::from_str(&env, "Test factory-deployed governor");
    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"factory-test-proposal"))
        .into();
    let metadata_uri = soroban_sdk::String::from_str(&env, "ipfs://factory-test-proposal");

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
    assert_eq!(proposal_id, 1, "first proposal should have ID 1");
    assert_eq!(governor_client.state(&proposal_id), ProposalState::Pending);

    // Advance to voting period
    env.ledger().with_mut(|l| l.sequence_number = 11);
    assert_eq!(governor_client.state(&proposal_id), ProposalState::Active);

    // Cast votes
    governor_client.cast_vote(&alice, &proposal_id, &VoteSupport::For);
    governor_client.cast_vote(&bob, &proposal_id, &VoteSupport::For);

    let (votes_for, votes_against, votes_abstain) = governor_client.proposal_votes(&proposal_id);
    assert_eq!(votes_for, 1000, "total votes should be 1000 (500 + 500)");
    assert_eq!(votes_against, 0);
    assert_eq!(votes_abstain, 0);

    // Advance past voting period
    env.ledger().with_mut(|l| l.sequence_number = 31);
    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Succeeded
    );

    // Queue proposal
    let ts_before_queue = env.ledger().timestamp();
    governor_client.queue(&proposal_id);
    assert_eq!(governor_client.state(&proposal_id), ProposalState::Queued);

    // Advance time past timelock delay
    env.ledger()
        .with_mut(|l| l.timestamp = ts_before_queue + timelock_delay + 1);

    // Execute proposal
    assert!(
        !mock_client.was_called(),
        "target should not be called before execute"
    );
    governor_client.execute(&proposal_id);
    assert!(
        mock_client.was_called(),
        "target should be called after execute"
    );
    assert_eq!(governor_client.state(&proposal_id), ProposalState::Executed);
}

// ---------------------------------------------------------------------------
// Test: get_governor returns correct addresses post-deploy
// ---------------------------------------------------------------------------

#[test]
fn test_get_governor_returns_correct_addresses() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    env.register(GovernorContract, ());
    env.register(TimelockContract, ());
    env.register(TokenVotesContract, ());

    let (governor_hash, timelock_hash, token_votes_hash) = upload_wasms(&env);

    let admin = Address::generate(&env);
    let deployer = Address::generate(&env);
    let token = Address::generate(&env);
    let guardian = admin.clone();
    let vote_type = 1u32;
    let proposal_grace_period = 120_960u32;

    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);

    factory.initialize(&admin, &governor_hash, &timelock_hash, &token_votes_hash);

    // Deploy first governance stack
    let id1 = factory.deploy(
        &deployer,
        &token,
        &100u32,
        &1000u32,
        &50u32,
        &0i128,
        &3600u64,
        &guardian,
        &vote_type,
        &proposal_grace_period,
    );

    // Retrieve and verify
    let entry1 = factory.get_governor(&id1);
    assert_eq!(entry1.id, id1);
    assert_eq!(entry1.deployer, deployer);

    // Deploy second governance stack
    let id2 = factory.deploy(
        &deployer,
        &token,
        &200u32,
        &2000u32,
        &40u32,
        &0i128,
        &7200u64,
        &guardian,
        &vote_type,
        &proposal_grace_period,
    );

    // Retrieve both and verify they're distinct
    let entry2 = factory.get_governor(&id2);
    assert_eq!(entry2.id, id2);

    assert_ne!(
        entry1.governor, entry2.governor,
        "governors must be distinct"
    );
    assert_ne!(
        entry1.timelock, entry2.timelock,
        "timelocks must be distinct"
    );
    assert_ne!(entry1.token, entry2.token, "token-votes must be distinct");
}

// ---------------------------------------------------------------------------
// Test: Factory emits GovernorDeployed event
// ---------------------------------------------------------------------------

#[test]
fn test_factory_emits_deployment_event() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    env.register(GovernorContract, ());
    env.register(TimelockContract, ());
    env.register(TokenVotesContract, ());

    let (governor_hash, timelock_hash, token_votes_hash) = upload_wasms(&env);

    let admin = Address::generate(&env);
    let deployer = Address::generate(&env);
    let token = Address::generate(&env);
    let guardian = admin.clone();
    let vote_type = 1u32;
    let proposal_grace_period = 120_960u32;

    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);

    factory.initialize(&admin, &governor_hash, &timelock_hash, &token_votes_hash);

    // Count events before deployment
    let events_before = env.events().all().len();

    // Deploy and capture events
    factory.deploy(
        &deployer,
        &token,
        &100u32,
        &1000u32,
        &50u32,
        &0i128,
        &3600u64,
        &guardian,
        &vote_type,
        &proposal_grace_period,
    );

    // Verify at least one event was emitted during deployment
    let events = env.events().all();
    let events_after = events.len();
    assert!(
        events_after > events_before,
        "factory should emit events during deployment"
    );

    let last_event = events.last().expect("expected a deployment event");
    assert_eq!(last_event.0, factory_id);
    assert_eq!(
        last_event.1.len(),
        5,
        "deployment event should include id and contract addresses"
    );
}

// ---------------------------------------------------------------------------
// Test: Deterministic salt-based address prediction
// ---------------------------------------------------------------------------

#[test]
fn test_deterministic_address_prediction() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    env.register(GovernorContract, ());
    env.register(TimelockContract, ());
    env.register(TokenVotesContract, ());

    let (governor_hash, timelock_hash, token_votes_hash) = upload_wasms(&env);

    let admin = Address::generate(&env);
    let deployer = Address::generate(&env);
    let token = Address::generate(&env);
    let guardian = admin.clone();
    let vote_type = 1u32;
    let proposal_grace_period = 120_960u32;

    let factory_id = env.register(GovernorFactoryContract, ());
    let factory = GovernorFactoryContractClient::new(&env, &factory_id);

    factory.initialize(&admin, &governor_hash, &timelock_hash, &token_votes_hash);

    // Deploy first stack
    let id1 = factory.deploy(
        &deployer,
        &token,
        &100u32,
        &1000u32,
        &50u32,
        &0i128,
        &3600u64,
        &guardian,
        &vote_type,
        &proposal_grace_period,
    );
    let entry1 = factory.get_governor(&id1);

    // Manually compute expected addresses using the same salt logic
    let id_bytes = id1.to_be_bytes();
    let mut salt_bin = [0u8; 32];
    salt_bin[0..8].copy_from_slice(&id_bytes);

    // Token-Votes (salt suffix 1)
    salt_bin[31] = 1;
    let expected_token_votes = env.as_contract(&factory_id, || {
        env.deployer()
            .with_current_contract(BytesN::from_array(&env, &salt_bin))
            .deployed_address()
    });

    // Timelock (salt suffix 2)
    salt_bin[31] = 2;
    let expected_timelock = env.as_contract(&factory_id, || {
        env.deployer()
            .with_current_contract(BytesN::from_array(&env, &salt_bin))
            .deployed_address()
    });

    // Governor (salt suffix 3)
    salt_bin[31] = 3;
    let expected_governor = env.as_contract(&factory_id, || {
        env.deployer()
            .with_current_contract(BytesN::from_array(&env, &salt_bin))
            .deployed_address()
    });

    // Verify addresses match predictions
    assert_eq!(
        entry1.token, expected_token_votes,
        "token-votes address must be deterministic"
    );
    assert_eq!(
        entry1.timelock, expected_timelock,
        "timelock address must be deterministic"
    );
    assert_eq!(
        entry1.governor, expected_governor,
        "governor address must be deterministic"
    );
}
