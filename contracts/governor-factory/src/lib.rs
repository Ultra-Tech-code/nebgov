#![no_std]
#![allow(clippy::too_many_arguments)]
#![allow(deprecated)]

use soroban_sdk::{
    contract, contractclient, contractimpl, contracterror, contracttype, symbol_short, Address,
    BytesN, Env,
};

/// Error codes returned by the governor factory.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FactoryError {
    InvalidVotingPeriod = 1,
    InvalidQuorumNumerator = 2,
    InvalidTimelockDelay = 3,
    InvalidVoteType = 4,
}

#[contracttype]
#[derive(Clone)]
pub enum VoteType {
    Simple,
    Extended,
    Quadratic,
}

/// Registry entry for a deployed governor.
#[contracttype]
#[derive(Clone)]
pub struct GovernorEntry {
    pub id: u64,
    pub governor: Address,
    pub timelock: Address,
    pub token: Address,
    pub deployer: Address,
}

#[contracttype]
pub enum DataKey {
    GovernorCount,
    Governor(u64),
    GovernorWasm,
    TimelockWasm,
    TokenVotesWasm,
    Admin,
}

#[contractclient(name = "TokenVotesClient")]
pub trait TokenVotesTrait {
    fn initialize(env: Env, admin: Address, token: Address);
}

#[contractclient(name = "TimelockClient")]
pub trait TimelockTrait {
    fn initialize(
        env: Env,
        admin: Address,
        governor: Address,
        min_delay: u64,
        execution_window: u64,
    );
}

#[contractclient(name = "GovernorClient")]
pub trait GovernorTrait {
    fn initialize(
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
    );
    fn set_initial_config(
        env: Env,
        admin: Address,
        max_calldata_size: u32,
        proposal_cooldown: u32,
        max_proposals_per_period: u32,
    );
}

#[contract]
pub struct GovernorFactoryContract;

#[contractimpl]
impl GovernorFactoryContract {
    /// Initialize factory with contract WASM hashes.
    pub fn initialize(
        env: Env,
        admin: Address,
        governor_wasm: BytesN<32>,
        timelock_wasm: BytesN<32>,
        token_votes_wasm: BytesN<32>,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::GovernorWasm, &governor_wasm);
        env.storage()
            .instance()
            .set(&DataKey::TimelockWasm, &timelock_wasm);
        env.storage()
            .instance()
            .set(&DataKey::TokenVotesWasm, &token_votes_wasm);
        env.storage().instance().set(&DataKey::GovernorCount, &0u64);
    }

    /// Deploy a new governor + timelock pair and register it.
    #[allow(clippy::too_many_arguments)]
    pub fn deploy(
        env: Env,
        deployer: Address,
        token: Address,
        voting_delay: u32,
        voting_period: u32,
        quorum_numerator: u32,
        proposal_threshold: i128,
        timelock_delay: u64,
        guardian: Address,
        vote_type: u32, // 0=Simple, 1=Extended, 2=Quadratic
        proposal_grace_period: u32,
    ) -> u64 {
        deployer.require_auth();

        // Validate settings before deploying so misconfigured governors are
        // rejected before any contract deployment takes place.
        if voting_period == 0 {
            env.panic_with_error(FactoryError::InvalidVotingPeriod);
        }
        if quorum_numerator == 0 {
            env.panic_with_error(FactoryError::InvalidQuorumNumerator);
        }
        if timelock_delay == 0 {
            env.panic_with_error(FactoryError::InvalidTimelockDelay);
        }
        if vote_type > 2 {
            env.panic_with_error(FactoryError::InvalidVoteType);
        }

        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::GovernorCount)
            .unwrap_or(0);
        let id = count + 1;

        // Retrieve WASM hashes from storage
        #[allow(unused_variables)]
        let governor_wasm: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::GovernorWasm)
            .expect("governor wasm not set");
        #[allow(unused_variables)]
        let timelock_wasm: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::TimelockWasm)
            .expect("timelock wasm not set");
        #[allow(unused_variables)]
        let token_votes_wasm: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::TokenVotesWasm)
            .expect("token-votes wasm not set");

        // Generate deterministic salts for each contract based on the ID.
        // This ensures that for a given factory and ID, the addresses are predictable.
        let id_bytes = id.to_be_bytes();
        let mut salt_bin = [0u8; 32];
        salt_bin[0..8].copy_from_slice(&id_bytes);

        // Deploy the dependency contracts.
        //
        // In unit tests we register the contracts directly (instead of deploying external WASM)
        // to avoid VM validation failures when the test environment does not support certain
        // WASM features that may be present in the compiled binaries.
        let (token_votes_addr, timelock_addr, governor_addr) = {
            #[cfg(test)]
            {
                use sorogov_governor::GovernorContract;
                use sorogov_timelock::TimelockContract;
                use sorogov_token_votes::TokenVotesContract;

                salt_bin[31] = 1;
                let token_votes_addr = env
                    .deployer()
                    .with_current_contract(BytesN::from_array(&env, &salt_bin))
                    .deployed_address();
                salt_bin[31] = 2;
                let timelock_addr = env
                    .deployer()
                    .with_current_contract(BytesN::from_array(&env, &salt_bin))
                    .deployed_address();
                salt_bin[31] = 3;
                let governor_addr = env
                    .deployer()
                    .with_current_contract(BytesN::from_array(&env, &salt_bin))
                    .deployed_address();

                env.register_at(&token_votes_addr, TokenVotesContract, ());
                env.register_at(&timelock_addr, TimelockContract, ());
                env.register_at(&governor_addr, GovernorContract, ());

                (token_votes_addr, timelock_addr, governor_addr)
            }

            #[cfg(not(test))]
            {
                // Deploy Token-Votes (salt suffix 1)
                salt_bin[31] = 1;
                let token_votes_addr = env
                    .deployer()
                    .with_current_contract(BytesN::from_array(&env, &salt_bin))
                    .deploy(token_votes_wasm);

                // Deploy Timelock (salt suffix 2)
                salt_bin[31] = 2;
                let timelock_addr = env
                    .deployer()
                    .with_current_contract(BytesN::from_array(&env, &salt_bin))
                    .deploy(timelock_wasm);

                // Deploy Governor (salt suffix 3)
                salt_bin[31] = 3;
                let governor_addr = env
                    .deployer()
                    .with_current_contract(BytesN::from_array(&env, &salt_bin))
                    .deploy(governor_wasm);

                (token_votes_addr, timelock_addr, governor_addr)
            }
        };

        // 1. Initialize Token-Votes with the underlying token
        TokenVotesClient::new(&env, &token_votes_addr).initialize(&deployer, &token);

        // 2. Initialize Timelock with the Governor address
        TimelockClient::new(&env, &timelock_addr).initialize(
            &deployer,
            &governor_addr,
            &timelock_delay,
            &1_209_600u64, // Default execution window (14 days)
        );

        // 3. Initialize Governor with Token-Votes and Timelock addresses
        // Convert vote_type u32 to VoteType enum
        let vote_type_enum = match vote_type {
            0 => VoteType::Simple,
            1 => VoteType::Extended,
            2 => VoteType::Quadratic,
            _ => VoteType::Extended, // Default to Extended
        };

        GovernorClient::new(&env, &governor_addr).initialize(
            &deployer,
            &token_votes_addr,
            &timelock_addr,
            &voting_delay,
            &voting_period,
            &quorum_numerator,
            &proposal_threshold,
            &guardian,
            &vote_type_enum,
            &proposal_grace_period,
        );

        let entry = GovernorEntry {
            id,
            governor: governor_addr.clone(),
            timelock: timelock_addr.clone(),
            token: token_votes_addr.clone(),
            deployer: deployer.clone(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Governor(id), &entry);
        env.storage().instance().set(&DataKey::GovernorCount, &id);

        env.events().publish(
            (symbol_short!("deploy"),),
            (
                id,
                governor_addr.clone(),
                timelock_addr.clone(),
                token_votes_addr.clone(),
                deployer.clone(),
            ),
        );

        id
    }

    /// Get a registered governor by ID.
    pub fn get_governor(env: Env, id: u64) -> GovernorEntry {
        env.storage()
            .persistent()
            .get(&DataKey::Governor(id))
            .expect("governor not found")
    }

    /// Get total number of deployed governors.
    pub fn governor_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::GovernorCount)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod integration_tests;
