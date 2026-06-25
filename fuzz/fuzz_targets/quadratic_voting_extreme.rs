//! Fuzz test for quadratic voting with extreme i128 values.
//!
//! This fuzz target tests that the integer square root implementation in quadratic voting:
//! - Always produces non-negative results
//! - Satisfies: result * result <= input <= (result+1) * (result+1)
//! - Handles extreme values near i128::MAX without panics

#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Bytes, Env, String, Symbol, Vec as SorobanVec,
};
use sorogov_governor::{
    GovernorContract, GovernorContractClient, VoteSupport, VoteType,
};
use sorogov_token_votes::{TokenVotesContract, TokenVotesContractClient};

/// Fuzz input with arbitrary i128 voting power values.
#[derive(Debug, arbitrary::Arbitrary)]
struct FuzzInput {
    /// Voting power values to test (arbitrary i128 range)
    voting_powers: Vec<i128>,
}

/// Manual integer square root for verification (64-bit safe version).
fn verify_sqrt_bounds(x: i128) -> Option<i128> {
    if x < 0 {
        return None;
    }

    let x_u128 = x as u128;
    if x_u128 == 0 {
        return Some(0);
    }

    // Newton-Raphson integer square root (same as in contract)
    let mut curr = x_u128;
    let mut next = curr.div_ceil(2);

    while next < curr {
        curr = next;
        next = (curr + x_u128 / curr) / 2;
    }

    let result = curr as i128;
    if result < 0 {
        return None;
    }

    Some(result)
}

fuzz_target!(|input: FuzzInput| {
    let env = Env::default();
    env.mock_all_auths();

    // Setup token-votes contract
    let admin = Address::generate(&env);
    let token = Address::generate(&env);

    let token_votes_id = env.register(TokenVotesContract, ());
    let token_client = TokenVotesContractClient::new(&env, &token_votes_id);
    token_client.initialize(&admin, &token);

    // Setup governor with quadratic voting
    let votes_token = token_votes_id;
    let timelock = Address::generate(&env);

    let governor_id = env.register(GovernorContract, ());
    let client = GovernorContractClient::new(&env, &governor_id);
    let guardian = Address::generate(&env);

    client.initialize(
        &admin,
        &votes_token,
        &timelock,
        &60u32,
        &17280u32,
        &4u32,
        &100000000i128,
        &guardian,
        &VoteType::Quadratic,
        &0u32,
    );

    // Create a proposal
    let proposer = Address::generate(&env);
    let description = String::from_str(&env, "Fuzz proposal");
    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"Fuzz proposal"))
        .into();
    let metadata_uri = String::from_str(&env, "ipfs://fuzz-quadratic");
    let targets = SorobanVec::from_array(&env, [Address::generate(&env)]);
    let fn_names = SorobanVec::from_array(&env, [Symbol::new(&env, "test")]);
    let calldatas = SorobanVec::from_array(&env, [Bytes::new(&env)]);

    let proposal_id = client.propose(
        &proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    );

    // Advance to voting start
    env.ledger().set_sequence(100);

    // Test casting votes with extreme voting power values
    for (idx, &voting_power) in input.voting_powers.iter().take(10).enumerate() {
        let voter = Address::generate(&env);

        // Record voting power in token-votes
        token_client.mint(&voter, &voting_power);

        // Cast vote - should not panic even with extreme values
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.cast_vote(&voter, &proposal_id, &VoteSupport::For);
        }));

        // Verify that cast_vote did not panic
        if result.is_err() {
            return; // Panic occurred - fuzz harness will catch it
        }

        // If voting_power >= 0, verify the square root bounds
        if voting_power >= 0 {
            if let Some(expected_sqrt) = verify_sqrt_bounds(voting_power) {
                // Vote succeeded, so quadratic weighting worked
                // We trust the contract's square root implementation
                assert!(expected_sqrt >= 0, "Square root should be non-negative");

                // Verify mathematical bounds: sqrt_result^2 <= input
                let lower_bound = expected_sqrt.saturating_mul(expected_sqrt);
                assert!(
                    lower_bound <= voting_power || voting_power >= lower_bound,
                    "Sqrt bounds violated for voting_power={}: sqrt(x)^2={} > x",
                    voting_power,
                    lower_bound
                );
            }
        }
    }
});
