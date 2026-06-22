import re

with open('contracts/liquidity/src/tests.rs', 'r') as f:
    content = f.read()

# Fix unused token_a, token_b warnings
# Change `token_a, token_b` to `_token_a, _token_b` if they are not used.
# The unused warnings were lines 85, 108.
content = content.replace("_, _, token_a, token_b) = setup_liquidity();", "_, _, _token_a, _token_b) = setup_liquidity();")

# Fix test_governor_proposal_executes_liquidity_fee_update
# Add token mints and variables before liquidity_id.
setup_tokens_str = """    let votes_client = MockVotesContractClient::new(&env, &votes_id);
    votes_client.set_votes(&proposer, &500);
    votes_client.set_votes(&voter, &500);
    votes_client.set_total_supply(&1_000);

    let liquidity_id = env.register(LiquidityContract, ());"""

new_setup_tokens_str = """    let votes_client = MockVotesContractClient::new(&env, &votes_id);
    votes_client.set_votes(&proposer, &500);
    votes_client.set_votes(&voter, &500);
    votes_client.set_total_supply(&1_000);

    let token_a = env.register_stellar_asset_contract_v2(admin.clone()).address();
    let token_b = env.register_stellar_asset_contract_v2(admin.clone()).address();
    soroban_sdk::token::StellarAssetClient::new(&env, &token_a).mint(&provider, &1_000_000);
    soroban_sdk::token::StellarAssetClient::new(&env, &token_b).mint(&provider, &1_000_000);

    let liquidity_id = env.register(LiquidityContract, ());"""

content = content.replace(setup_tokens_str, new_setup_tokens_str)

with open('contracts/liquidity/src/tests.rs', 'w') as f:
    f.write(content)

