#![no_std]
#![allow(clippy::too_many_arguments)]

//! Protocol-owned liquidity management for NebGov markets.
//!
//! This contract maintains simple two-asset pools used to support market
//! liquidity around governance-controlled prediction or outcome tokens. End
//! users can add liquidity, remove liquidity, and swap against a pool using a
//! constant-product pricing curve with configurable fees.
//!
//! The contract integrates with NebGov governance through a stored governor
//! address. Day-to-day user actions are self-authorized by the caller, while
//! privileged configuration changes such as fee updates are restricted to the
//! governor and are intended to be executed through the governor -> timelock ->
//! liquidity proposal flow.
//!
//! Access control model:
//! - liquidity providers must authorize `add_liquidity` and `remove_liquidity`
//! - traders must authorize `swap`
//! - only the configured governor may call `create_pool`, `initialize_pool`, and `update_pool_fee`

use soroban_sdk::token::TokenClient;
use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env};

const MIN_LIQUIDITY: i128 = 1_000;
const MAX_FEE_BPS: u32 = 1_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Pool {
    pub reserve_a: i128,
    pub reserve_b: i128,
    pub total_lp_supply: i128,
    pub fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolMetadata {
    pub created_by: Address,
    pub created_ledger: u32,
    pub created_timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LPPosition {
    pub lp_tokens: i128,
}

#[contracttype]
enum DataKey {
    Governor,
    Pool(u32, u32),
    PoolMetadata(u32, u32),
    Position(Address, u32, u32),
    PoolTokens(u32, u32),
}

/// Liquidity contract error codes.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiquidityError {
    /// Amount must be positive (not zero or negative).
    InvalidAmount = 1,
    /// Caller does not have sufficient LP shares for this operation.
    InsufficientShares = 2,
    /// Subsequent deposit does not maintain the pool's current reserve ratio.
    ImbalancedDeposit = 3,
    /// Arithmetic overflow while calculating or updating pool accounting.
    ArithmeticOverflow = 4,
}

#[contract]
pub struct LiquidityContract;

#[contractimpl]
impl LiquidityContract {
    /// Initialize the contract with the governor that owns privileged actions.
    pub fn initialize(env: Env, governor: Address) {
        governor.require_auth();
        assert!(
            !env.storage().instance().has(&DataKey::Governor),
            "already initialized"
        );
        env.storage().instance().set(&DataKey::Governor, &governor);
    }

    /// Return the configured governor address.
    pub fn governor(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized")
    }

    /// Register a new pool's token addresses. Must be called once before adding liquidity.
    pub fn create_pool(
        env: Env,
        caller: Address,
        outcome_a: u32,
        outcome_b: u32,
        token_a: Address,
        token_b: Address,
    ) {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        let tokens_key = DataKey::PoolTokens(outcome_a, outcome_b);
        if env.storage().persistent().has(&tokens_key) {
            panic!("pool already exists");
        }
        env.storage()
            .persistent()
            .set(&tokens_key, &(token_a, token_b));
    }

    /// Initialize an explicitly approved pool with its starting fee.
    ///
    /// Token addresses are registered separately with `create_pool`; both steps
    /// are governor-gated, and `add_liquidity` requires both records to exist.
    pub fn initialize_pool(
        env: Env,
        caller: Address,
        outcome_a: u32,
        outcome_b: u32,
        fee_bps: u32,
    ) {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        if fee_bps > MAX_FEE_BPS {
            panic!("fee too high");
        }

        let pool_key = Self::pool_key(outcome_a, outcome_b);
        if env.storage().persistent().has(&pool_key) {
            panic!("pool already initialized");
        }

        let pool = Pool {
            reserve_a: 0,
            reserve_b: 0,
            total_lp_supply: 0,
            fee_bps,
        };
        let metadata = PoolMetadata {
            created_by: caller,
            created_ledger: env.ledger().sequence(),
            created_timestamp: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&pool_key, &pool);
        env.storage()
            .persistent()
            .set(&Self::pool_metadata_key(outcome_a, outcome_b), &metadata);
    }

    /// Add liquidity to a pool and mint LP shares.
    ///
    /// Returns `(lp_tokens, deposit_b)`. `deposit_b` is the amount of B actually
    /// credited to the pool (equal to `required_b` for subsequent deposits, or
    /// `amount_b` for the first deposit). Callers should use `deposit_b` to
    /// reconcile their balance — any `amount_b` in excess of `deposit_b` was not
    /// consumed.
    pub fn add_liquidity(
        env: Env,
        provider: Address,
        outcome_a: u32,
        outcome_b: u32,
        amount_a: i128,
        amount_b: i128,
    ) -> (i128, i128) {
        provider.require_auth();

        if amount_a <= 0 || amount_b <= 0 {
            panic!("amounts must be positive");
        }

        if amount_a < MIN_LIQUIDITY {
            panic!("below minimum liquidity");
        }

        // Checks & Reads
        let tokens_key = DataKey::PoolTokens(outcome_a, outcome_b);
        let stored_tokens: Option<(Address, Address)> = env.storage().persistent().get(&tokens_key);
        let (token_a, token_b) = stored_tokens.expect("pool not registered");

        let pool_key = Self::pool_key(outcome_a, outcome_b);
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&pool_key)
            .expect("pool not initialized");
        let position_key = Self::position_key(provider.clone(), outcome_a, outcome_b);
        let mut position: LPPosition = env
            .storage()
            .persistent()
            .get(&position_key)
            .unwrap_or(LPPosition { lp_tokens: 0 });

        // For subsequent deposits, enforce the current reserve ratio so that
        // callers cannot shift the pool price by providing an arbitrary amount_b.
        // `required_b` is the exact amount_b that keeps reserve_b/reserve_a constant.
        // `amount_b` acts as a caller-supplied maximum (slippage guard): if the pool
        // has moved so that required_b exceeds amount_b, the call is rejected.
        // Only `required_b` is credited to the pool regardless of how large amount_b is,
        // preventing value extraction through inflated reserve_b contributions.
        let (lp_tokens, deposit_b) = if pool.total_lp_supply == 0 {
            if amount_b < MIN_LIQUIDITY {
                panic!("below minimum liquidity");
            }
            (amount_a, amount_b)
        } else {
            let required_b = Self::checked_mul(&env, amount_a, pool.reserve_b) / pool.reserve_a;
            if required_b < MIN_LIQUIDITY {
                panic!("below minimum liquidity");
            }
            if amount_b < required_b {
                panic!("imbalanced deposit: amount_b below required ratio");
            }
            let lp = Self::checked_mul(&env, amount_a, pool.total_lp_supply) / pool.reserve_a;
            if lp == 0 {
                panic!("deposit too small: zero LP tokens would be minted");
            }
            (lp, required_b)
        };

        // Effects
        pool.reserve_a = Self::checked_add(&env, pool.reserve_a, amount_a);
        pool.reserve_b = Self::checked_add(&env, pool.reserve_b, deposit_b);
        pool.total_lp_supply = Self::checked_add(&env, pool.total_lp_supply, lp_tokens);
        position.lp_tokens = Self::checked_add(&env, position.lp_tokens, lp_tokens);

        env.storage().persistent().set(&pool_key, &pool);
        env.storage().persistent().set(&position_key, &position);

        // Interactions
        TokenClient::new(&env, &token_a).transfer(
            &provider,
            &env.current_contract_address(),
            &amount_a,
        );
        TokenClient::new(&env, &token_b).transfer(
            &provider,
            &env.current_contract_address(),
            &deposit_b,
        );

        (lp_tokens, deposit_b)
    }

    /// Remove liquidity from a pool and burn LP shares.
    pub fn remove_liquidity(
        env: Env,
        provider: Address,
        outcome_a: u32,
        outcome_b: u32,
        lp_tokens: i128,
    ) -> (i128, i128) {
        provider.require_auth();

        // Security: validate caller inputs before any state mutation or token transfer.
        // A failed check here leaves contract state unchanged.
        if lp_tokens <= 0 {
            panic!("invalid amount");
        }

        let provider_shares =
            Self::get_lp_position(env.clone(), provider.clone(), outcome_a, outcome_b);
        if lp_tokens > provider_shares {
            panic!("insufficient shares");
        }

        // Checks & Reads
        let pool_key = Self::pool_key(outcome_a, outcome_b);
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&pool_key)
            .expect("pool not found");

        let position_key = Self::position_key(provider.clone(), outcome_a, outcome_b);
        let mut position: LPPosition = env
            .storage()
            .persistent()
            .get(&position_key)
            .expect("no LP position");

        let tokens_key = DataKey::PoolTokens(outcome_a, outcome_b);
        let stored_tokens: Option<(Address, Address)> = env.storage().persistent().get(&tokens_key);
        let (token_a, token_b) = stored_tokens.expect("pool tokens not found");

        let amount_a = (lp_tokens * pool.reserve_a) / pool.total_lp_supply;
        let amount_b = (lp_tokens * pool.reserve_b) / pool.total_lp_supply;

        // Effects
        pool.reserve_a -= amount_a;
        pool.reserve_b -= amount_b;
        pool.total_lp_supply -= lp_tokens;
        position.lp_tokens -= lp_tokens;

        env.storage().persistent().set(&pool_key, &pool);
        env.storage().persistent().set(&position_key, &position);

        // Interactions
        TokenClient::new(&env, &token_a).transfer(
            &env.current_contract_address(),
            &provider,
            &amount_a,
        );
        TokenClient::new(&env, &token_b).transfer(
            &env.current_contract_address(),
            &provider,
            &amount_b,
        );

        (amount_a, amount_b)
    }

    /// Swap `amount_in` of one pool asset for the other.
    pub fn swap(
        env: Env,
        trader: Address,
        outcome_in: u32,
        outcome_out: u32,
        amount_in: i128,
        min_amount_out: i128,
    ) -> i128 {
        trader.require_auth();

        if amount_in <= 0 {
            panic!("amount_in must be positive");
        }

        // Checks & Reads
        let pool_key = Self::pool_key(outcome_in, outcome_out);
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&pool_key)
            .expect("pool not found");

        let tokens_key = DataKey::PoolTokens(outcome_in, outcome_out);
        let stored_tokens: Option<(Address, Address)> = env.storage().persistent().get(&tokens_key);
        let (token_in, token_out) = stored_tokens.expect("pool tokens not found");

        let amount_out = (amount_in * pool.reserve_b) / (pool.reserve_a + amount_in);
        let fee = (amount_out * pool.fee_bps as i128) / 10_000;
        let amount_out_with_fee = amount_out - fee;

        if amount_out_with_fee < min_amount_out {
            panic!("slippage exceeded");
        }

        // Effects
        pool.reserve_a += amount_in;
        pool.reserve_b -= amount_out_with_fee;
        env.storage().persistent().set(&pool_key, &pool);

        // Interactions
        TokenClient::new(&env, &token_in).transfer(
            &trader,
            &env.current_contract_address(),
            &amount_in,
        );
        TokenClient::new(&env, &token_out).transfer(
            &env.current_contract_address(),
            &trader,
            &amount_out_with_fee,
        );

        amount_out_with_fee
    }

    /// Update a pool fee. Only the configured governor may call this.
    pub fn update_pool_fee(
        env: Env,
        caller: Address,
        outcome_a: u32,
        outcome_b: u32,
        fee_bps: u32,
    ) {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        if fee_bps > MAX_FEE_BPS {
            panic!("fee too high");
        }

        let pool_key = Self::pool_key(outcome_a, outcome_b);
        let mut pool: Pool = env
            .storage()
            .persistent()
            .get(&pool_key)
            .expect("pool not found");
        pool.fee_bps = fee_bps;
        env.storage().persistent().set(&pool_key, &pool);
    }

    /// Get the current pool state.
    pub fn get_pool(env: Env, outcome_a: u32, outcome_b: u32) -> Pool {
        env.storage()
            .persistent()
            .get(&Self::pool_key(outcome_a, outcome_b))
            .expect("pool not found")
    }

    /// Get immutable metadata recorded when the pool was initialized.
    pub fn get_pool_metadata(env: Env, outcome_a: u32, outcome_b: u32) -> PoolMetadata {
        env.storage()
            .persistent()
            .get(&Self::pool_metadata_key(outcome_a, outcome_b))
            .expect("pool metadata not found")
    }

    /// Get the LP token balance for a provider in a specific pool.
    pub fn get_lp_position(env: Env, provider: Address, outcome_a: u32, outcome_b: u32) -> i128 {
        let position: LPPosition = env
            .storage()
            .persistent()
            .get(&Self::position_key(provider, outcome_a, outcome_b))
            .unwrap_or(LPPosition { lp_tokens: 0 });
        position.lp_tokens
    }

    /// Calculate the current pool price as reserve_b / reserve_a scaled by 10_000.
    pub fn get_price(env: Env, outcome_a: u32, outcome_b: u32) -> i128 {
        let pool = Self::get_pool(env, outcome_a, outcome_b);
        if pool.reserve_a == 0 {
            return 0;
        }
        (pool.reserve_b * 10_000) / pool.reserve_a
    }

    fn require_governor(env: &Env, caller: &Address) {
        assert!(caller == &Self::governor(env.clone()), "only governor");
    }

    fn pool_key(outcome_a: u32, outcome_b: u32) -> DataKey {
        DataKey::Pool(outcome_a, outcome_b)
    }

    fn pool_metadata_key(outcome_a: u32, outcome_b: u32) -> DataKey {
        DataKey::PoolMetadata(outcome_a, outcome_b)
    }

    fn position_key(provider: Address, outcome_a: u32, outcome_b: u32) -> DataKey {
        DataKey::Position(provider, outcome_a, outcome_b)
    }

    fn checked_add(env: &Env, lhs: i128, rhs: i128) -> i128 {
        lhs.checked_add(rhs)
            .unwrap_or_else(|| env.panic_with_error(LiquidityError::ArithmeticOverflow))
    }

    fn checked_mul(env: &Env, lhs: i128, rhs: i128) -> i128 {
        lhs.checked_mul(rhs)
            .unwrap_or_else(|| env.panic_with_error(LiquidityError::ArithmeticOverflow))
    }
}

#[cfg(test)]
mod tests;
