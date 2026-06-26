use crate::{GovernorContract, GovernorContractClient, ProposalState, VoteType};
use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};
use sorogov_timelock::TimelockContract;
use sorogov_token_votes::TokenVotesContract;

#[test]
fn test_cancel_by_governance_success() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    let votes_id = env.register(TokenVotesContract, ());
    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    // Initialize the timelock so its MinDelay and ExecutionWindow storage keys
    // are set; some timelock methods expect these values to exist.
    let timelock_client = sorogov_timelock::TimelockContractClient::new(&env, &timelock_id);
    let min_delay: u64 = 1;
    let execution_window: u64 = 86_400;
    timelock_client.initialize(&admin, &governor_id, &min_delay, &execution_window);

    let governor_client = GovernorContractClient::new(&env, &governor_id);

    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &20_u32,
        &0_u32,
        &0_i128,
        &Address::generate(&env),
        &VoteType::Extended,
        &120_960u32,
    );

    let proposer = Address::generate(&env);
    let targets = soroban_sdk::vec![&env, Address::generate(&env)];
    let fn_names = soroban_sdk::vec![&env, Symbol::new(&env, "test")];
    let calldatas = soroban_sdk::vec![&env, soroban_sdk::Bytes::new(&env)];

    let proposal_id = governor_client.propose(
        &proposer,
        &soroban_sdk::String::from_str(&env, "test"),
        &env.crypto().sha256(&soroban_sdk::Bytes::new(&env)).into(),
        &soroban_sdk::String::from_str(&env, "test"),
        &targets,
        &fn_names,
        &calldatas,
    );

    // Call cancel_by_governance
    // With mock_all_auths, require_auth() will succeed
    governor_client.cancel_by_governance(&proposal_id);

    assert_eq!(
        governor_client.state(&proposal_id),
        ProposalState::Cancelled
    );
}

#[test]
#[should_panic]
fn test_cancel_by_governance_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    let votes_id = env.register(TokenVotesContract, ());
    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let governor_client = GovernorContractClient::new(&env, &governor_id);

    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &10_u32,
        &20_u32,
        &0_u32,
        &0_i128,
        &Address::generate(&env),
        &VoteType::Extended,
        &120_960u32,
    );

    let proposer = Address::generate(&env);
    let targets = soroban_sdk::vec![&env, Address::generate(&env)];
    let fn_names = soroban_sdk::vec![&env, Symbol::new(&env, "test")];
    let calldatas = soroban_sdk::vec![&env, soroban_sdk::Bytes::new(&env)];

    let proposal_id = governor_client.propose(
        &proposer,
        &soroban_sdk::String::from_str(&env, "test"),
        &env.crypto().sha256(&soroban_sdk::Bytes::new(&env)).into(),
        &soroban_sdk::String::from_str(&env, "test"),
        &targets,
        &fn_names,
        &calldatas,
    );

    // Call from unauthorized address (alice)
    let alice = Address::generate(&env);
    env.as_contract(&alice, || {
        governor_client.cancel_by_governance(&proposal_id);
    });
}
