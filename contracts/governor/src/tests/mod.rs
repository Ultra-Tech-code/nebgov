mod governance_cancel;
mod integration;

// ── upgrade auth tests ────────────────────────────────────────────────────────
// Note: a full end-to-end upgrade test (auth passes → WASM swapped) requires
// a compiled WASM binary uploaded via env.deployer().upload_contract_wasm().
// That path is covered by integration tests run after `cargo build --target
// wasm32-unknown-unknown`. The unit tests below focus on the auth guard,
// which is the security-critical invariant.

use crate::{GovernorContract, GovernorContractClient, GovernorSettings, VoteType};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events, MockAuth, MockAuthInvoke},
    Address, BytesN, Env, IntoVal, Symbol, TryIntoVal,
};

mod mock_timelock {
    use super::*;

    #[contract]
    pub struct MockTimelockContract;

    #[contractimpl]
    impl MockTimelockContract {
        pub fn min_delay(_env: Env) -> u64 {
            1
        }

        pub fn execution_window(_env: Env) -> u64 {
            60
        }
    }
}

mod mock_timelock_zero_window {
    use super::*;

    #[contract]
    pub struct MockTimelockZeroWindowContract;

    #[contractimpl]
    impl MockTimelockZeroWindowContract {
        pub fn min_delay(_env: Env) -> u64 {
            1
        }

        pub fn execution_window(_env: Env) -> u64 {
            0
        }
    }
}

pub use mock_timelock::MockTimelockContract;
pub use mock_timelock_zero_window::MockTimelockZeroWindowContract;

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

#[allow(dead_code)]
fn settings_with_defaults(_env: &Env, guardian: Address) -> GovernorSettings {
    GovernorSettings {
        voting_delay: 200,
        voting_period: 2000,
        quorum_numerator: 10,
        proposal_threshold: 500,
        guardian,
        vote_type: VoteType::Extended,
        proposal_grace_period: 120_960,
        use_dynamic_quorum: false,
        reflector_oracle: None,
        min_quorum_usd: 0,
        max_calldata_size: 10_000,
        proposal_cooldown: 100,
        max_proposals_per_period: 5,
        proposal_period_duration: 10_000,
    }
}

#[test]
#[should_panic]
fn upgrade_rejects_caller_that_is_not_the_contract_address() {
    // Fresh env — no mock_all_auths. We mock auth as a random attacker so
    // that the contract's own require_auth check finds no matching mock
    // and panics with an auth error.
    let env = Env::default();
    let contract_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &contract_id);

    let attacker = Address::generate(&env);
    let new_wasm_hash = BytesN::from_array(&env, &[2u8; 32]);

    // Only `attacker` is mocked, not `contract_id`. upgrade() calls
    // env.current_contract_address().require_auth() which looks for
    // (contract_id, "upgrade") — it won't find it and panics.
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "upgrade",
            args: (new_wasm_hash.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    client.upgrade(&new_wasm_hash);
}

#[test]
#[should_panic]
fn upgrade_rejects_admin_acting_as_direct_caller() {
    // Even the stored admin cannot bypass the contract-self auth guard.
    // The only valid upgrade path is through an executed on-chain proposal.
    let env = Env::default();
    let admin = Address::generate(&env);
    let votes_token = Address::generate(&env);
    let timelock = env.register(MockTimelockContract, ());
    let contract_id = env.register(GovernorContract, ());

    env.mock_all_auths();
    let guardian = Address::generate(&env);
    GovernorContractClient::new(&env, &contract_id).initialize(
        &admin,
        &votes_token,
        &timelock,
        &100u32,
        &1000u32,
        &40u32,
        &0i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    let new_wasm_hash = BytesN::from_array(&env, &[3u8; 32]);
    let client = GovernorContractClient::new(&env, &contract_id);

    // Replace mock_all_auths with a specific mock for admin only.
    // The upgrade guard requires contract_id, not admin — must panic.
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "upgrade",
            args: (new_wasm_hash.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    client.upgrade(&new_wasm_hash);
}

#[test]
#[should_panic]
fn update_config_rejects_caller_that_is_not_the_contract_address() {
    let env = Env::default();
    let contract_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &contract_id);

    let attacker = Address::generate(&env);
    let new_settings = GovernorSettings {
        voting_delay: 200,
        voting_period: 2000,
        quorum_numerator: 10,
        proposal_threshold: 500,
        guardian: Address::generate(&env),
        vote_type: VoteType::Extended,
        proposal_grace_period: 120_960,
        use_dynamic_quorum: false,
        reflector_oracle: None,
        min_quorum_usd: 0,
        max_calldata_size: 10_000,
        proposal_cooldown: 100,
        max_proposals_per_period: 5,
        proposal_period_duration: 10_000,
    };

    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "update_config",
            args: (new_settings.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    client.update_config(&new_settings);
}

#[test]
fn update_config_succeeds_with_contract_self_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let votes_token = Address::generate(&env);
    let timelock = env.register(MockTimelockContract, ());
    let contract_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &contract_id);

    let guardian = Address::generate(&env);
    client.initialize(
        &admin,
        &votes_token,
        &timelock,
        &100u32,
        &1000u32,
        &4u32,
        &0i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    let old_settings = client.get_settings();
    assert_eq!(old_settings.voting_delay, 100);
    assert_eq!(old_settings.voting_period, 1000);
    assert_eq!(old_settings.quorum_numerator, 4);
    assert_eq!(old_settings.proposal_threshold, 0);

    let new_settings = GovernorSettings {
        voting_delay: 200,
        voting_period: 2000,
        quorum_numerator: 5,
        proposal_threshold: 1000,
        guardian: old_settings.guardian.clone(),
        vote_type: VoteType::Simple,
        proposal_grace_period: 604800,
        use_dynamic_quorum: false,
        reflector_oracle: None,
        min_quorum_usd: 0,
        max_calldata_size: 10_000,
        proposal_cooldown: 100,
        max_proposals_per_period: 5,
        proposal_period_duration: 10_000,
    };

    client.update_config(&new_settings);

    let updated = client.get_settings();
    assert_eq!(updated.voting_delay, 200);
    assert_eq!(updated.voting_period, 2000);
    assert_eq!(updated.quorum_numerator, 5);
    assert_eq!(updated.proposal_threshold, 1000);
}

#[test]
fn update_governor_limit_settings_succeed_with_contract_self_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let votes_token = Address::generate(&env);
    let timelock = Address::generate(&env);
    let contract_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &contract_id);

    let guardian = Address::generate(&env);
    client.initialize(
        &admin,
        &votes_token,
        &timelock,
        &100u32,
        &1000u32,
        &4u32,
        &0i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    client.update_max_calldata_size(&20_000u32);
    client.update_proposal_cooldown(&250u32);
    client.update_max_proposals_per_period(&10u32);

    let updated = client.get_settings();
    assert_eq!(updated.max_calldata_size, 20_000);
    assert_eq!(updated.proposal_cooldown, 250);
    assert_eq!(updated.max_proposals_per_period, 10);
    assert_eq!(count_topic(&env, "ConfigUpdated"), 3);
}

#[test]
#[should_panic(expected = "voting delay exceeds maximum")]
fn update_config_rejects_excessive_voting_delay() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let votes_token = Address::generate(&env);
    let timelock = env.register(MockTimelockContract, ());
    let contract_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &contract_id);
    let guardian = Address::generate(&env);

    client.initialize(
        &admin,
        &votes_token,
        &timelock,
        &100u32,
        &1000u32,
        &4u32,
        &0i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    let mut settings = client.get_settings();
    settings.voting_delay = 1_209_601;

    client.update_config(&settings);
}

#[test]
#[should_panic(expected = "voting period must be positive")]
fn update_config_rejects_short_voting_period() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let votes_token = Address::generate(&env);
    let timelock = env.register(MockTimelockContract, ());
    let contract_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &contract_id);
    let guardian = Address::generate(&env);

    client.initialize(
        &admin,
        &votes_token,
        &timelock,
        &100u32,
        &1000u32,
        &4u32,
        &0i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    let mut settings = client.get_settings();
    settings.voting_period = 0;

    client.update_config(&settings);
}

#[test]
#[should_panic(expected = "quorum numerator must be at most 100")]
fn update_config_rejects_invalid_quorum_numerator() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let votes_token = Address::generate(&env);
    let timelock = env.register(MockTimelockContract, ());
    let contract_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &contract_id);
    let guardian = Address::generate(&env);

    client.initialize(
        &admin,
        &votes_token,
        &timelock,
        &100u32,
        &1000u32,
        &4u32,
        &0i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    let mut settings = client.get_settings();
    settings.quorum_numerator = 101;

    client.update_config(&settings);
}

#[test]
#[should_panic(expected = "proposal threshold must be non-negative")]
fn update_config_rejects_negative_proposal_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let votes_token = Address::generate(&env);
    let timelock = env.register(MockTimelockContract, ());
    let contract_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &contract_id);
    let guardian = Address::generate(&env);

    client.initialize(
        &admin,
        &votes_token,
        &timelock,
        &100u32,
        &1000u32,
        &4u32,
        &0i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );

    let mut settings = client.get_settings();
    settings.proposal_threshold = -1;

    client.update_config(&settings);
}

#[test]
#[should_panic(expected = "Error(Contract, #28)")]
fn initialize_rejects_zero_voting_period() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let votes_token = Address::generate(&env);
    let timelock = env.register(MockTimelockContract, ());
    let contract_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &contract_id);
    let guardian = Address::generate(&env);

    client.initialize(
        &admin,
        &votes_token,
        &timelock,
        &100u32,
        &0u32,
        &4u32,
        &0i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #29)")]
fn initialize_rejects_zero_execution_window() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let votes_token = Address::generate(&env);
    let timelock = env.register(MockTimelockZeroWindowContract, ());
    let contract_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &contract_id);
    let guardian = Address::generate(&env);

    client.initialize(
        &admin,
        &votes_token,
        &timelock,
        &100u32,
        &1000u32,
        &4u32,
        &0i128,
        &guardian,
        &VoteType::Extended,
        &120_960u32,
    );
}

#[test]
fn governor_upgraded_event_helper_emits_expected_topic() {
    let env = Env::default();
    let contract_id = env.register(GovernorContract, ());
    let old_hash = BytesN::from_array(&env, &[7u8; 32]);
    let new_hash = BytesN::from_array(&env, &[8u8; 32]);

    env.as_contract(&contract_id, || {
        crate::events::emit_governor_upgraded(&env, &old_hash, &new_hash);
    });

    assert_eq!(env.events().all().len(), 1);
}
