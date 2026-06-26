use super::{LiquidityContract, LiquidityContractClient, LiquidityError};
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _},
    Address, Bytes, Env, IntoVal, String, Symbol, Val, Vec,
};
use sorogov_governor::{GovernorContract, GovernorContractClient, VoteSupport, VoteType};
use sorogov_timelock::{TimelockContract, TimelockContractClient};

#[contracttype]
#[derive(Clone)]
enum MockVotesDataKey {
    Votes(Address),
    TotalSupply,
}

#[contract]
pub struct MockVotesContract;

#[contractimpl]
impl MockVotesContract {
    pub fn set_votes(env: Env, account: Address, votes: i128) {
        env.storage()
            .instance()
            .set(&MockVotesDataKey::Votes(account), &votes);
    }

    pub fn set_total_supply(env: Env, total_supply: i128) {
        env.storage()
            .instance()
            .set(&MockVotesDataKey::TotalSupply, &total_supply);
    }

    pub fn get_votes(env: Env, account: Address) -> i128 {
        env.storage()
            .instance()
            .get(&MockVotesDataKey::Votes(account))
            .unwrap_or(0)
    }

    pub fn get_past_votes(env: Env, account: Address, _ledger: u32) -> i128 {
        Self::get_votes(env, account)
    }

    pub fn get_past_total_supply(env: Env, _ledger: u32) -> i128 {
        env.storage()
            .instance()
            .get(&MockVotesDataKey::TotalSupply)
            .unwrap_or(0)
    }
}

use soroban_sdk::token::StellarAssetClient;

fn setup_liquidity() -> (Env, Address, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LiquidityContract, ());
    let client = LiquidityContractClient::new(&env, &contract_id);

    let governor = Address::generate(&env);
    let provider = Address::generate(&env);
    let trader = Address::generate(&env);
    let admin = Address::generate(&env);

    let token_a = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let token_b = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();

    let sac_a = StellarAssetClient::new(&env, &token_a);
    let sac_b = StellarAssetClient::new(&env, &token_b);
    sac_a.mint(&provider, &1_000_000);
    sac_b.mint(&provider, &1_000_000);
    sac_a.mint(&trader, &1_000_000);
    sac_b.mint(&trader, &1_000_000);

    client.initialize(&governor);

    (
        env,
        contract_id,
        governor,
        provider,
        trader,
        token_a,
        token_b,
    )
}

fn setup_pool(
    client: &LiquidityContractClient<'_>,
    governor: &Address,
    outcome_a: u32,
    outcome_b: u32,
    token_a: &Address,
    token_b: &Address,
) {
    client.create_pool(governor, &outcome_a, &outcome_b, token_a, token_b);
    client.initialize_pool(governor, &outcome_a, &outcome_b, &30);
}

fn mint_pair(
    env: &Env,
    token_a: &Address,
    token_b: &Address,
    account: &Address,
    amount_a: i128,
    amount_b: i128,
) {
    StellarAssetClient::new(env, token_a).mint(account, &amount_a);
    StellarAssetClient::new(env, token_b).mint(account, &amount_b);
}

#[test]
fn test_initialize_sets_governor() {
    let (env, contract_id, governor, _, _, _token_a, _token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    assert_eq!(client.governor(), governor);
}

#[test]
fn test_add_liquidity_creates_pool_and_position() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    let (lp_tokens, deposit_b) = client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    assert_eq!(lp_tokens, 10_000);
    assert_eq!(deposit_b, 10_000);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 10_000);
    assert_eq!(pool.reserve_b, 10_000);
    assert_eq!(pool.total_lp_supply, 10_000);
    assert_eq!(pool.fee_bps, 30);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 10_000);
}

#[test]
fn test_get_lp_position_defaults_to_zero() {
    let (env, contract_id, _, _, _, _token_a, _token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let unknown_provider = Address::generate(&env);
    assert_eq!(client.get_lp_position(&unknown_provider, &0, &1), 0);
}

#[test]
fn test_initialize_pool_records_zero_reserve_pool_and_metadata() {
    let (env, contract_id, governor, _, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 0);
    assert_eq!(pool.reserve_b, 0);
    assert_eq!(pool.total_lp_supply, 0);
    assert_eq!(pool.fee_bps, 30);

    let metadata = client.get_pool_metadata(&0, &1);
    assert_eq!(metadata.created_by, governor);
    assert_eq!(metadata.created_ledger, env.ledger().sequence());
    assert_eq!(metadata.created_timestamp, env.ledger().timestamp());
}

#[test]
#[should_panic(expected = "pool not initialized")]
fn test_add_liquidity_rejects_uninitialized_pool() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    client.create_pool(&governor, &0, &1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
}

#[test]
#[should_panic(expected = "only governor")]
fn test_initialize_pool_rejects_non_governor() {
    let (env, contract_id, _, provider, _, _token_a, _token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    client.initialize_pool(&provider, &0, &1, &30);
}

#[test]
#[should_panic(expected = "only governor")]
fn test_create_pool_rejects_non_governor() {
    let (env, contract_id, _, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    client.create_pool(&provider, &0, &1, &token_a, &token_b);
}

#[test]
fn test_remove_liquidity_burns_lp_tokens() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    let (amount_a, amount_b) = client.remove_liquidity(&provider, &0, &1, &4_000);

    assert_eq!(amount_a, 4_000);
    assert_eq!(amount_b, 4_000);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 6_000);
    assert_eq!(pool.reserve_b, 6_000);
    assert_eq!(pool.total_lp_supply, 6_000);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 6_000);
}

#[test]
fn test_swap_updates_reserves_and_price() {
    let (env, contract_id, governor, provider, trader, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    let price_before = client.get_price(&0, &1);
    let amount_out = client.swap(&trader, &0, &1, &1_000, &0);
    let price_after = client.get_price(&0, &1);

    assert!(amount_out > 0);
    assert!(amount_out < 1_000);
    assert!(price_after < price_before);
}

#[test]
fn test_update_pool_fee_changes_fee_for_governor() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    client.update_pool_fee(&governor, &0, &1, &75);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.fee_bps, 75);
}

#[test]
#[should_panic(expected = "only governor")]
fn test_update_pool_fee_rejects_non_governor() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let unauthorized = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    client.update_pool_fee(&unauthorized, &0, &1, &75);
}

#[test]
#[should_panic(expected = "amounts must be positive")]
fn test_add_liquidity_rejects_zero_amounts() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &0, &10_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_add_liquidity_rejects_arithmetic_overflow() {
    let (env, contract_id, governor, _, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let whale = Address::generate(&env);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    StellarAssetClient::new(&env, &token_a).mint(&whale, &i128::MAX);
    StellarAssetClient::new(&env, &token_b).mint(&whale, &i128::MAX);

    client.add_liquidity(&whale, &0, &1, &i128::MAX, &i128::MAX);
    client.add_liquidity(&provider2, &0, &1, &1_000, &1_000);
}

#[test]
#[should_panic(expected = "fee too high")]
fn test_update_pool_fee_rejects_excessive_fee() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    client.update_pool_fee(&governor, &0, &1, &1_001);
}

#[test]
fn test_governor_proposal_executes_liquidity_fee_update() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);
    let provider = Address::generate(&env);

    let votes_id = env.register(MockVotesContract, ());
    let votes_client = MockVotesContractClient::new(&env, &votes_id);
    votes_client.set_votes(&proposer, &500);
    votes_client.set_votes(&voter, &500);
    votes_client.set_total_supply(&1_000);

    let token_a = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let token_b = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    soroban_sdk::token::StellarAssetClient::new(&env, &token_a).mint(&provider, &1_000_000);
    soroban_sdk::token::StellarAssetClient::new(&env, &token_b).mint(&provider, &1_000_000);

    let liquidity_id = env.register(LiquidityContract, ());
    let liquidity_client = LiquidityContractClient::new(&env, &liquidity_id);

    let timelock_id = env.register(TimelockContract, ());
    let governor_id = env.register(GovernorContract, ());

    let timelock_client = TimelockContractClient::new(&env, &timelock_id);
    let governor_client = GovernorContractClient::new(&env, &governor_id);

    liquidity_client.initialize(&governor_id);
    liquidity_client.create_pool(&governor_id, &0, &1, &token_a, &token_b);
    liquidity_client.initialize_pool(&governor_id, &0, &1, &30);
    liquidity_client.add_liquidity(&provider, &0, &1, &10_000, &10_000);

    timelock_client.initialize(&admin, &governor_id, &1, &1_209_600);
    governor_client.initialize(
        &admin,
        &votes_id,
        &timelock_id,
        &0,
        &5,
        &0,
        &0,
        &guardian,
        &VoteType::Extended,
        &120_960,
    );

    let description = String::from_str(&env, "Update liquidity pool fee");
    let description_hash = env
        .crypto()
        .sha256(&Bytes::from_slice(&env, b"update-liquidity-pool-fee"))
        .into();
    let metadata_uri = String::from_str(&env, "ipfs://liquidity-fee-update");

    let mut targets = Vec::new(&env);
    targets.push_back(liquidity_id.clone());

    let mut fn_names = Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "update_pool_fee"));

    let mut args: Vec<Val> = Vec::new(&env);
    args.push_back(governor_id.clone().into_val(&env));
    args.push_back(0u32.into_val(&env));
    args.push_back(1u32.into_val(&env));
    args.push_back(75u32.into_val(&env));

    let mut calldatas = Vec::new(&env);
    calldatas.push_back(args.to_xdr(&env));

    let proposal_id = governor_client.propose(
        &proposer,
        &description,
        &description_hash,
        &metadata_uri,
        &targets,
        &fn_names,
        &calldatas,
    );

    governor_client.cast_vote(&voter, &proposal_id, &VoteSupport::For);
    env.ledger().with_mut(|ledger| ledger.sequence_number = 6);

    governor_client.queue(&proposal_id);
    let queued_pool = liquidity_client.get_pool(&0, &1);
    assert_eq!(queued_pool.fee_bps, 30);

    let queue_timestamp = env.ledger().timestamp();
    env.ledger()
        .with_mut(|ledger| ledger.timestamp = queue_timestamp + 2);

    governor_client.execute(&proposal_id);

    let updated_pool = liquidity_client.get_pool(&0, &1);
    assert_eq!(updated_pool.fee_bps, 75);
}
// ============================================================================
// TESTS FOR RATIO ENFORCEMENT IN ADD_LIQUIDITY (Issue #588)
// ============================================================================

#[test]
#[should_panic(expected = "imbalanced deposit")]
fn test_add_liquidity_rejects_amount_b_below_ratio() {
    // Pool has a 1:2 ratio (A:B). A subsequent deposit providing too little B
    // must be rejected so the pool price cannot be manipulated downward.
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &20_000); // ratio 1:2
                                                               // required_b = 1_000 * 20_000 / 10_000 = 2_000; providing only 1_000 must panic
    client.add_liquidity(&provider2, &0, &1, &1_000, &1_000);
}

#[test]
fn test_add_liquidity_excess_amount_b_only_credits_required() {
    // When amount_b exceeds what the reserve ratio requires, only the
    // proportionally correct required_b is credited to pool reserves.
    // This prevents reserve_b inflation while allowing a caller-supplied
    // slippage buffer (excess is silently trimmed).
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &20_000); // ratio 1:2
    mint_pair(&env, &token_a, &token_b, &provider2, 1_000, 2_000);

    // Provider2 declares amount_b = 99_990 (far above required 2_000 for 1_000 A).
    // Only required_b = 1_000 * 20_000 / 10_000 = 2_000 should be credited.
    client.add_liquidity(&provider2, &0, &1, &1_000, &99_990);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 11_000);
    assert_eq!(pool.reserve_b, 22_000); // 20_000 + 2_000, not 20_000 + 99_990
                                        // Ratio 1:2 preserved
    assert_eq!(pool.reserve_b / pool.reserve_a, 2);
}

#[test]
fn test_add_liquidity_proportional_second_deposit_exact() {
    // A deposit providing exactly the proportional amount_b passes and
    // maintains the pool ratio without any rounding drift.
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &20_000); // ratio 1:2
    mint_pair(&env, &token_a, &token_b, &provider2, 5_000, 10_000);
    client.add_liquidity(&provider2, &0, &1, &5_000, &10_000); // exact: 5000*2=10000

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 15_000);
    assert_eq!(pool.reserve_b, 30_000);
    assert_eq!(pool.reserve_b / pool.reserve_a, 2);
}

#[test]
fn test_add_liquidity_lp_tokens_minted_correctly_for_second_deposit() {
    // LP tokens for a second deposit must be proportional to amount_a only,
    // ensuring both providers hold fair shares of the pool.
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    let (lp1, _) = client.add_liquidity(&provider, &0, &1, &10_000, &20_000);
    assert_eq!(lp1, 10_000);

    // 5_000 A is 50% of reserve_a=10_000 → should mint 5_000 LP tokens
    mint_pair(&env, &token_a, &token_b, &provider2, 5_000, 10_000);
    let (lp2, _) = client.add_liquidity(&provider2, &0, &1, &5_000, &10_000);
    assert_eq!(lp2, 5_000);

    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.total_lp_supply, 15_000);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 10_000);
    assert_eq!(client.get_lp_position(&provider2, &0, &1), 5_000);
}

#[test]
fn test_add_liquidity_first_deposit_accepts_any_ratio() {
    // The first deposit (total_lp_supply == 0) sets the initial price and must
    // not be subject to any ratio check.
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    let (lp, deposit_b) = client.add_liquidity(&provider, &0, &1, &1_000, &99_000);
    assert_eq!(lp, 1_000);
    assert_eq!(deposit_b, 99_000);
    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 1_000);
    assert_eq!(pool.reserve_b, 99_000);
}

#[test]
fn test_add_liquidity_poc_attack_prevented() {
    // Reproduction of the PoC from issue #588:
    //   Alice seeds the pool at ratio 1:2.
    //   Bob calls add_liquidity with proportional amount_a but a massive amount_b.
    //
    // Before the fix, Bob's deposit inflated reserve_b, corrupting the pool price
    // and letting Alice extract far more B than she deposited.
    //
    // After the fix, only required_b is credited for Bob's deposit, the pool
    // ratio stays at 1:2, and Alice's withdrawal recovers exactly what she put in.
    let (env, contract_id, governor, alice, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let bob = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    // Alice: 10_000 A + 20_000 B → 10_000 LP, ratio 1:2
    client.add_liquidity(&alice, &0, &1, &10_000, &20_000);

    // Bob: 1_000 A + 100_000 B (attack: amount_b far exceeds the 1:2 ratio).
    // required_b = 1_000 * 20_000 / 10_000 = 2_000 → only 2_000 B credited.
    mint_pair(&env, &token_a, &token_b, &bob, 1_000, 2_000);
    client.add_liquidity(&bob, &0, &1, &1_000, &100_000);

    let pool = client.get_pool(&0, &1);
    // Pool must reflect only the proportional deposit, not the inflated one
    assert_eq!(pool.reserve_a, 11_000);
    assert_eq!(pool.reserve_b, 22_000); // 20_000 + 2_000, not 20_000 + 100_000
    assert_eq!(pool.reserve_b / pool.reserve_a, 2); // ratio intact

    // Bob holds 1_000 LP tokens (1_000 * 10_000 / 10_000 = 1_000)
    assert_eq!(client.get_lp_position(&bob, &0, &1), 1_000);

    // Alice removes her 10_000 LP and must recover approximately what she put in
    let (alice_a, alice_b) = client.remove_liquidity(&alice, &0, &1, &10_000);
    // 10_000/11_000 of reserve_a=11_000 = 10_000 A
    // 10_000/11_000 of reserve_b=22_000 = 20_000 B
    assert_eq!(alice_a, 10_000);
    assert_eq!(alice_b, 20_000);
}

#[test]
fn test_add_liquidity_returns_actual_deposit_b() {
    // add_liquidity now returns (lp_tokens, deposit_b). deposit_b is the amount
    // of B actually credited — equal to required_b, not the caller-supplied amount_b.
    // Integrators must use deposit_b to reconcile their balance.
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &20_000); // ratio 1:2

    // required_b = 5_000 * 20_000 / 10_000 = 10_000; caller passes 50_000 as slippage buffer
    mint_pair(&env, &token_a, &token_b, &provider2, 5_000, 10_000);
    let (lp_tokens, deposit_b) = client.add_liquidity(&provider2, &0, &1, &5_000, &50_000);
    assert_eq!(lp_tokens, 5_000);
    assert_eq!(deposit_b, 10_000); // only proportional amount credited, not 50_000
}

#[test]
#[should_panic(expected = "below minimum liquidity")]
fn test_add_liquidity_rejects_required_b_below_minimum() {
    // On a heavily skewed pool (large reserve_a, tiny reserve_b), required_b for
    // a small deposit rounds down below MIN_LIQUIDITY. This must be rejected even
    // when amount_b is well above MIN_LIQUIDITY (the old guard was insufficient).
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    // Seed pool: 1_000_000 A vs 1_000 B (heavily skewed)
    client.add_liquidity(&provider, &0, &1, &1_000_000, &1_000);
    // required_b = 1_000 * 1_000 / 1_000_000 = 1 — below MIN_LIQUIDITY (1_000)
    // amount_b = 5_000 passes the old guard but required_b does not
    client.add_liquidity(&provider2, &0, &1, &1_000, &5_000);
}

#[test]
#[should_panic(expected = "deposit too small: zero LP tokens would be minted")]
fn test_add_liquidity_rejects_deposit_that_mints_zero_lp_tokens() {
    // When reserve_a >> total_lp (which occurs after heavy A-in swaps), integer
    // division in `lp = amount_a * total_lp / reserve_a` yields 0 even for a
    // minimum-sized deposit. Without the guard the caller loses both amounts with
    // no LP tokens to show for it.
    //
    // Setup (pool 2/3, separate from the test's default pool 0/1):
    //   First deposit: 1_000 A + 1_000_000_000 B → total_lp = 1_000
    //   Swap 1_000_000 A in:
    //     amount_out = 1_000_000 * 1_000_000_000 / 1_001_000 = 999_000_999
    //     fee        = 999_000_999 * 30 / 10_000 = 2_997_002
    //     net_out    = 996_003_997
    //     → reserve_a = 1_001_000, reserve_b = 3_996_003, total_lp = 1_000
    //   Second deposit (1_000 A):
    //     required_b = 1_000 * 3_996_003 / 1_001_000 = 3_992  (≥ MIN_LIQUIDITY ✓)
    //     lp         = 1_000 * 1_000 / 1_001_000 = 0          (1_001_000 > 1_000_000)
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let provider2 = Address::generate(&env);

    setup_pool(&client, &governor, 2, 3, &token_a, &token_b);
    StellarAssetClient::new(&env, &token_a).mint(&provider, &1_000_000);
    StellarAssetClient::new(&env, &token_b).mint(&provider, &1_000_000_000);
    client.add_liquidity(&provider, &2, &3, &1_000, &1_000_000_000);
    client.swap(&provider, &2, &3, &1_000_000, &0);
    // amount_b = 4_000 ≥ required_b = 3_992; only lp = 0 triggers the panic
    client.add_liquidity(&provider2, &2, &3, &1_000, &4_000);
}

// ============================================================================
// SECURITY TESTS FOR REMOVE_LIQUIDITY GUARDS (Issue #471)
// ============================================================================

#[test]
#[should_panic(expected = "invalid amount")]
fn test_remove_liquidity_rejects_zero_shares() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);

    // Attempt to remove zero shares - should panic with InvalidAmount
    client.remove_liquidity(&provider, &0, &1, &0);
}

#[test]
#[should_panic(expected = "invalid amount")]
fn test_remove_liquidity_rejects_negative_shares() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);

    // Attempt to remove negative shares - should panic with InvalidAmount
    client.remove_liquidity(&provider, &0, &1, &-1);
}

#[test]
#[should_panic(expected = "insufficient shares")]
fn test_remove_liquidity_rejects_excessive_shares() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Provider adds 100 LP tokens
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 10_000);

    // Attempt to remove 10_001 shares (exceeds balance of 10_000) - should panic with InsufficientShares
    client.remove_liquidity(&provider, &0, &1, &10_001);
}

#[test]
#[should_panic(expected = "insufficient shares")]
fn test_remove_liquidity_rejects_zero_share_provider_positive_amount() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);
    let other_provider = Address::generate(&env);

    // Setup: provider1 adds liquidity
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);

    // other_provider has zero LP shares (never added liquidity)
    assert_eq!(client.get_lp_position(&other_provider, &0, &1), 0);

    // Attempt to remove positive shares as other_provider (who has 0 balance) - should panic with InsufficientShares
    client.remove_liquidity(&other_provider, &0, &1, &1);
}

#[test]
fn test_remove_liquidity_valid_exact_balance() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Setup: provider adds 10_000 LP tokens
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 10_000);

    // Remove exact balance (10_000 shares)
    let (amount_a, amount_b) = client.remove_liquidity(&provider, &0, &1, &10_000);

    // Verify correct amounts returned (should be proportional to 100% of reserves)
    assert_eq!(amount_a, 10_000);
    assert_eq!(amount_b, 10_000);

    // Verify provider's balance is now 0
    assert_eq!(client.get_lp_position(&provider, &0, &1), 0);

    // Verify pool reserves are depleted
    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 0);
    assert_eq!(pool.reserve_b, 0);
    assert_eq!(pool.total_lp_supply, 0);
}

#[test]
fn test_remove_liquidity_valid_partial_removal() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Setup: provider adds 10_000 LP tokens
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);
    assert_eq!(client.get_lp_position(&provider, &0, &1), 10_000);

    // Remove 50% (5_000 shares)
    let (amount_a, amount_b) = client.remove_liquidity(&provider, &0, &1, &5_000);

    // Verify correct amounts returned (50% of reserves)
    assert_eq!(amount_a, 5_000);
    assert_eq!(amount_b, 5_000);

    // Verify provider's remaining balance is 50%
    assert_eq!(client.get_lp_position(&provider, &0, &1), 5_000);

    // Verify pool reserves are reduced by 50%
    let pool = client.get_pool(&0, &1);
    assert_eq!(pool.reserve_a, 5_000);
    assert_eq!(pool.reserve_b, 5_000);
    assert_eq!(pool.total_lp_supply, 5_000);
}

#[test]
fn test_remove_liquidity_state_unchanged_on_invalid_amount_guard() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Setup: provider adds 10_000 LP tokens
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);

    // Record initial state
    let initial_balance = client.get_lp_position(&provider, &0, &1);
    let initial_pool = client.get_pool(&0, &1);

    // Attempt invalid removal (zero shares) - will panic
    let result = client.try_remove_liquidity(&provider, &0, &1, &0);
    assert!(result.is_err());

    // Verify state is unchanged after failed guard
    assert_eq!(client.get_lp_position(&provider, &0, &1), initial_balance);
    let pool_after = client.get_pool(&0, &1);
    assert_eq!(pool_after.reserve_a, initial_pool.reserve_a);
    assert_eq!(pool_after.reserve_b, initial_pool.reserve_b);
    assert_eq!(pool_after.total_lp_supply, initial_pool.total_lp_supply);
}

#[test]
fn test_remove_liquidity_state_unchanged_on_insufficient_shares_guard() {
    let (env, contract_id, governor, provider, _, token_a, token_b) = setup_liquidity();
    let client = LiquidityContractClient::new(&env, &contract_id);

    // Setup: provider adds 10_000 LP tokens
    setup_pool(&client, &governor, 0, 1, &token_a, &token_b);
    client.add_liquidity(&provider, &0, &1, &10_000, &10_000);

    // Record initial state
    let initial_balance = client.get_lp_position(&provider, &0, &1);
    let initial_pool = client.get_pool(&0, &1);

    // Attempt invalid removal (balance exceeded) - will panic
    let result = client.try_remove_liquidity(&provider, &0, &1, &10_001);
    assert!(result.is_err());

    // Verify state is unchanged after failed guard
    assert_eq!(client.get_lp_position(&provider, &0, &1), initial_balance);
    let pool_after = client.get_pool(&0, &1);
    assert_eq!(pool_after.reserve_a, initial_pool.reserve_a);
    assert_eq!(pool_after.reserve_b, initial_pool.reserve_b);
    assert_eq!(pool_after.total_lp_supply, initial_pool.total_lp_supply);
}

#[test]
fn test_liquidity_error_codes_snapshot() {
    // Snapshot: each LiquidityError variant maps to a stable u32.
    assert_eq!(LiquidityError::InvalidAmount as u32, 1);
    assert_eq!(LiquidityError::InsufficientShares as u32, 2);
    assert_eq!(LiquidityError::ImbalancedDeposit as u32, 3);
}
