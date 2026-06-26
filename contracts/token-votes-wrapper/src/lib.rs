#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, token, Address, Env, Vec};

/// A voting power checkpoint at a specific ledger sequence.
#[contracttype]
#[derive(Clone)]
pub struct Checkpoint {
    pub ledger: u32,
    pub votes: i128,
}

#[contracttype]
pub enum DataKey {
    Delegate(Address),    // delegator -> delegatee
    Checkpoints(Address), // account -> Vec<Checkpoint>
    TotalCheckpoints,     // global total supply checkpoints
    UnderlyingToken,      // SEP-41 token being wrapped
    Admin,
    LockedUntil(Address), // address -> ledger until which withdrawal is locked
    DepositorBalance(Address), // depositor -> wrapped token balance
}

#[contract]
pub struct TokenVotesWrapperContract;

impl TokenVotesWrapperContract {
    /// Binary search: find checkpoint votes at or before `ledger`.
    fn get_checkpoint_at(checkpoints: &Vec<Checkpoint>, ledger: u32) -> i128 {
        if checkpoints.is_empty() {
            return 0;
        }
        let mut lo: u32 = 0;
        let mut hi: u32 = checkpoints.len();
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let cp: Checkpoint = checkpoints.get(mid).unwrap();
            if cp.ledger <= ledger {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo == 0 {
            return 0;
        }
        let cp: Checkpoint = checkpoints.get(lo - 1).unwrap();
        cp.votes
    }

    /// Upsert checkpoint: if the last checkpoint is at the current ledger, update it;
    /// otherwise push a new one.
    fn write_checkpoint(env: &Env, checkpoints: &mut Vec<Checkpoint>, new_votes: i128) {
        let ledger = env.ledger().sequence();
        if let Some(last) = checkpoints.last() {
            let last_cp: Checkpoint = last;
            if last_cp.ledger == ledger {
                let idx = checkpoints.len() - 1;
                checkpoints.set(
                    idx,
                    Checkpoint {
                        ledger,
                        votes: new_votes,
                    },
                );
                return;
            }
        }
        checkpoints.push_back(Checkpoint {
            ledger,
            votes: new_votes,
        });
    }

    /// Move `delta` votes from `src` to `dst` in per-account checkpoints.
    fn move_voting_power(env: &Env, src: Option<&Address>, dst: Option<&Address>, delta: i128) {
        if delta == 0 {
            return;
        }
        if let Some(src_addr) = src {
            let mut cps: Vec<Checkpoint> = env
                .storage()
                .persistent()
                .get(&DataKey::Checkpoints(src_addr.clone()))
                .unwrap_or_else(|| Vec::new(env));
            let current = if cps.is_empty() {
                0
            } else {
                cps.last().map(|c: Checkpoint| c.votes).unwrap_or(0)
            };
            Self::write_checkpoint(env, &mut cps, current - delta);
            env.storage()
                .persistent()
                .set(&DataKey::Checkpoints(src_addr.clone()), &cps);
        }
        if let Some(dst_addr) = dst {
            let mut cps: Vec<Checkpoint> = env
                .storage()
                .persistent()
                .get(&DataKey::Checkpoints(dst_addr.clone()))
                .unwrap_or_else(|| Vec::new(env));
            let current = if cps.is_empty() {
                0
            } else {
                cps.last().map(|c: Checkpoint| c.votes).unwrap_or(0)
            };
            Self::write_checkpoint(env, &mut cps, current + delta);
            env.storage()
                .persistent()
                .set(&DataKey::Checkpoints(dst_addr.clone()), &cps);
        }
    }

    fn get_depositor_balance_internal(env: &Env, depositor: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::DepositorBalance(depositor))
            .unwrap_or(0)
    }

    fn set_depositor_balance(env: &Env, depositor: Address, balance: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::DepositorBalance(depositor), &balance);
    }
}

#[contractimpl]
impl TokenVotesWrapperContract {
    /// Initialize with the underlying SEP-41 token and admin.
    pub fn initialize(env: Env, admin: Address, underlying_token: Address) {
        admin.require_auth();
        assert!(
            env.storage()
                .instance()
                .get::<_, Address>(&DataKey::Admin)
                .is_none(),
            "already initialized"
        );
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::UnderlyingToken, &underlying_token);
    }

    /// Deposit `amount` of the underlying SEP-41 token and receive 1:1 wrapped voting tokens.
    /// Automatically self-delegates if the depositor has no delegatee set.
    pub fn deposit(env: Env, from: Address, amount: i128) {
        from.require_auth();
        assert!(amount > 0, "amount must be positive");

        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::UnderlyingToken)
            .expect("not initialized");

        // Transfer underlying tokens from depositor to wrapper contract
        let underlying_client = token::Client::new(&env, &underlying);
        underlying_client.transfer(&from, &env.current_contract_address(), &amount);

        let current_balance = Self::get_depositor_balance_internal(&env, from.clone());
        Self::set_depositor_balance(&env, from.clone(), current_balance + amount);

        // Credit wrapped voting tokens: update delegate's checkpoint
        let delegatee: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Delegate(from.clone()))
            .unwrap_or(from.clone());

        Self::move_voting_power(&env, None, Some(&delegatee), amount);

        // Update total supply checkpoint
        let mut total_cps: Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::TotalCheckpoints)
            .unwrap_or_else(|| Vec::new(&env));
        let current_total = total_cps.last().map(|c: Checkpoint| c.votes).unwrap_or(0);
        Self::write_checkpoint(&env, &mut total_cps, current_total + amount);
        env.storage()
            .persistent()
            .set(&DataKey::TotalCheckpoints, &total_cps);

        env.events()
            .publish((symbol_short!("deposit"), from), (underlying, amount));
    }

    /// Burn wrapped voting tokens and return underlying SEP-41 tokens.
    /// Reverts if the caller is locked (has voting power in an active proposal).
    pub fn withdraw(env: Env, from: Address, amount: i128) {
        from.require_auth();
        assert!(amount > 0, "amount must be positive");

        // Check withdrawal lock
        let locked_until: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::LockedUntil(from.clone()))
            .unwrap_or(0);
        assert!(
            env.ledger().sequence() > locked_until,
            "withdrawal locked: tokens used in active proposal"
        );

        let delegatee: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Delegate(from.clone()))
            .unwrap_or(from.clone());

        let current_balance = Self::get_depositor_balance_internal(&env, from.clone());
        assert!(amount <= current_balance, "InsufficientBalance");
        Self::set_depositor_balance(&env, from.clone(), current_balance - amount);

        Self::move_voting_power(&env, Some(&delegatee), None, amount);

        // Update total supply
        let mut total_cps: Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::TotalCheckpoints)
            .unwrap_or_else(|| Vec::new(&env));
        let current_total = total_cps.last().map(|c: Checkpoint| c.votes).unwrap_or(0);
        Self::write_checkpoint(&env, &mut total_cps, current_total - amount);
        env.storage()
            .persistent()
            .set(&DataKey::TotalCheckpoints, &total_cps);

        // Return underlying tokens
        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::UnderlyingToken)
            .expect("not initialized");
        let underlying_client = token::Client::new(&env, &underlying);
        underlying_client.transfer(&env.current_contract_address(), &from, &amount);

        env.events()
            .publish((symbol_short!("withdraw"), from), (underlying, amount));
    }

    /// Delegate voting power to another address.
    pub fn delegate(env: Env, delegator: Address, delegatee: Address) {
        delegator.require_auth();

        let old_delegatee: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Delegate(delegator.clone()))
            .unwrap_or(delegator.clone());

        let balance = Self::get_depositor_balance_internal(&env, delegator.clone());

        env.storage()
            .persistent()
            .set(&DataKey::Delegate(delegator.clone()), &delegatee);

        if old_delegatee != delegatee {
            Self::move_voting_power(&env, Some(&old_delegatee), Some(&delegatee), balance);
        }

        env.events().publish(
            (symbol_short!("delegate"), delegator),
            (old_delegatee, delegatee),
        );
    }

    /// Lock withdrawal for `from` until `end_ledger`.
    /// Called by an authorized governor contract when a proposal is active.
    pub fn lock_withdrawal(env: Env, caller: Address, from: Address, end_ledger: u32) {
        caller.require_auth();
        // Only the admin (governor) can call this
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert_eq!(caller, admin, "only admin can lock withdrawals");
        env.storage()
            .persistent()
            .set(&DataKey::LockedUntil(from), &end_ledger);
    }

    // --- VotesTrait compatible methods (for GovernorClient cross-contract calls) ---

    /// Get current voting power (latest checkpoint) for an account.
    pub fn get_votes(env: Env, account: Address) -> i128 {
        let cps: Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::Checkpoints(account))
            .unwrap_or_else(|| Vec::new(&env));
        cps.last().map(|c: Checkpoint| c.votes).unwrap_or(0)
    }

    /// Get snapshot voting power at a past ledger.
    pub fn get_past_votes(env: Env, account: Address, ledger: u32) -> i128 {
        let cps: Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::Checkpoints(account))
            .unwrap_or_else(|| Vec::new(&env));
        Self::get_checkpoint_at(&cps, ledger)
    }

    /// Get total wrapped token supply at a past ledger.
    pub fn get_past_total_supply(env: Env, ledger: u32) -> i128 {
        let cps: Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::TotalCheckpoints)
            .unwrap_or_else(|| Vec::new(&env));
        Self::get_checkpoint_at(&cps, ledger)
    }

    /// Get the delegatee for an account.
    pub fn get_delegate(env: Env, account: Address) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Delegate(account.clone()))
            .unwrap_or(account)
    }

    /// Get the wrapped balance deposited by an account.
    pub fn get_depositor_balance(env: Env, account: Address) -> i128 {
        Self::get_depositor_balance_internal(&env, account)
    }

    /// Get the underlying SEP-41 token address.
    pub fn underlying_token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::UnderlyingToken)
            .expect("not initialized")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        Env,
    };

    #[contract]
    pub struct MockSep41Token;

    #[contractimpl]
    impl MockSep41Token {
        pub fn initialize(env: Env, admin: Address) {
            env.storage()
                .instance()
                .set(&soroban_sdk::Symbol::new(&env, "admin"), &admin);
        }

        pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
            from.require_auth();
            let from_key = soroban_sdk::Symbol::new(&env, "bal_from");
            // Simplified: just track balance for `to`
            let _ = (from, to, amount, from_key);
        }
    }

    #[test]
    fn test_deposit_and_withdraw() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        // Register a real SAC for underlying token
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        let sac_client = soroban_sdk::token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&user, &1000_i128);

        let wrapper_id = env.register(TokenVotesWrapperContract, ());
        let wrapper = TokenVotesWrapperContractClient::new(&env, &wrapper_id);
        wrapper.initialize(&admin, &token_addr);

        // Deposit
        wrapper.deposit(&user, &500_i128);
        assert_eq!(wrapper.get_votes(&user), 500);

        // Check past supply
        env.ledger().with_mut(|l| l.sequence_number += 1);
        assert_eq!(wrapper.get_past_total_supply(&0), 500);
    }

    #[test]
    fn test_delegate_moves_voting_power() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        soroban_sdk::token::StellarAssetClient::new(&env, &token_addr).mint(&user, &1000_i128);

        let wrapper_id = env.register(TokenVotesWrapperContract, ());
        let wrapper = TokenVotesWrapperContractClient::new(&env, &wrapper_id);
        wrapper.initialize(&admin, &token_addr);
        wrapper.deposit(&user, &500_i128);

        // Delegate to another address
        wrapper.delegate(&user, &delegatee);
        assert_eq!(wrapper.get_votes(&delegatee), 500);
        assert_eq!(wrapper.get_votes(&user), 0);
    }

    #[test]
    fn test_redelegate_moves_only_depositor_balance() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);
        let delegatee = Address::generate(&env);
        let new_delegatee = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        let token_client = soroban_sdk::token::StellarAssetClient::new(&env, &token_addr);
        token_client.mint(&user1, &100_i128);
        token_client.mint(&user2, &900_i128);

        let wrapper_id = env.register(TokenVotesWrapperContract, ());
        let wrapper = TokenVotesWrapperContractClient::new(&env, &wrapper_id);
        wrapper.initialize(&admin, &token_addr);

        wrapper.deposit(&user1, &100_i128);
        wrapper.deposit(&user2, &900_i128);
        wrapper.delegate(&user1, &delegatee);
        wrapper.delegate(&user2, &delegatee);

        assert_eq!(wrapper.get_votes(&delegatee), 1000);

        wrapper.delegate(&user1, &new_delegatee);

        assert_eq!(wrapper.get_votes(&delegatee), 900);
        assert_eq!(wrapper.get_votes(&new_delegatee), 100);
        assert_eq!(wrapper.get_depositor_balance(&user1), 100);
        assert_eq!(wrapper.get_depositor_balance(&user2), 900);
    }

    #[test]
    #[should_panic(expected = "InsufficientBalance")]
    fn test_withdraw_rejects_overdraw_from_shared_delegatee() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        let token_client = soroban_sdk::token::StellarAssetClient::new(&env, &token_addr);
        token_client.mint(&user1, &100_i128);
        token_client.mint(&user2, &900_i128);

        let wrapper_id = env.register(TokenVotesWrapperContract, ());
        let wrapper = TokenVotesWrapperContractClient::new(&env, &wrapper_id);
        wrapper.initialize(&admin, &token_addr);

        wrapper.deposit(&user1, &100_i128);
        wrapper.deposit(&user2, &900_i128);
        wrapper.delegate(&user2, &user1);

        assert_eq!(wrapper.get_votes(&user1), 1000);

        env.ledger().with_mut(|l| l.sequence_number += 1);
        wrapper.withdraw(&user1, &500_i128);
    }

    #[test]
    #[should_panic(expected = "withdrawal locked")]
    fn test_withdraw_locked() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        soroban_sdk::token::StellarAssetClient::new(&env, &token_addr).mint(&user, &1000_i128);

        let wrapper_id = env.register(TokenVotesWrapperContract, ());
        let wrapper = TokenVotesWrapperContractClient::new(&env, &wrapper_id);
        wrapper.initialize(&admin, &token_addr);
        wrapper.deposit(&user, &500_i128);

        // Lock withdrawal until ledger 1000
        wrapper.lock_withdrawal(&admin, &user, &1000_u32);

        // Should panic
        wrapper.withdraw(&user, &500_i128);
    }
}
