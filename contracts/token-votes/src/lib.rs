#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env, Symbol,
};

#[cfg(test)]
mod load_tests;

/// A voting power checkpoint at a specific ledger sequence.
#[contracttype]
#[derive(Clone)]
pub struct Checkpoint {
    pub ledger: u32,
    pub votes: i128,
    pub weighted_sum: i128, // sum(balance_i * start_ledger_i)
}

#[contracttype]
#[derive(Clone, Default)]
pub struct DelegatorRecord {
    pub balance: i128,
    pub start_ledger: u32,
}

#[contracttype]
pub enum DataKey {
    Delegate(Address),    // delegator -> delegatee
    Checkpoints(Address), // account -> Vec<Checkpoint>
    TotalCheckpoints,     // Vec<Checkpoint> for total supply
    Token,                // underlying SEP-41 token address
    Admin,
    Nonce(Address),            // owner -> nonce for delegate_by_sig
    CheckpointRetentionPeriod, // u32: number of ledgers to retain checkpoints
    AccountList,               // Vec<Address>: all accounts that have checkpoints
    DelegatorRecord(Address),  // delegator -> DelegatorRecord
    TimeWeightEnabled,         // bool
    TimeWeightScale,           // u32
}

#[contract]
pub struct TokenVotesContract;

#[contractimpl]
impl TokenVotesContract {
    /// Initialize with the underlying SEP-41 token.
    pub fn initialize(env: Env, admin: Address, token: Address) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        // Set default retention period to 100,800 ledgers (~2 weeks at 7.5s per ledger)
        env.storage()
            .instance()
            .set(&DataKey::CheckpointRetentionPeriod, &100800u32);
        // Default time-weighting to disabled
        env.storage().instance().set(&DataKey::TimeWeightEnabled, &false);
        // Default scale to 4,204,800 (~1 year at 7.5s per ledger)
        env.storage().instance().set(&DataKey::TimeWeightScale, &4204800u32);
    }

    /// Delegate voting power from caller to delegatee.
    ///
    /// Reads the delegator's current token balance from the underlying SEP-41
    /// contract and records it in the total supply checkpoint the first time
    /// they delegate. Re-delegation between accounts does not change the total
    /// — voting power simply moves from the old delegatee to the new one
    /// without altering how much supply is actively delegated.
    pub fn delegate(env: Env, delegator: Address, delegatee: Address) {
        delegator.require_auth();
        Self::apply_delegation(&env, delegator, delegatee);
    }

    /// Explicitly revoke delegation and move voting power back to self.
    ///
    /// If the account is already self-delegated or has never delegated, this
    /// is a no-op.
    pub fn undelegate(env: Env, delegator: Address) {
        delegator.require_auth();

        let current_delegate: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Delegate(delegator.clone()));

        if let Some(delegatee) = current_delegate {
            if delegatee != delegator {
                Self::apply_delegation(&env, delegator.clone(), delegator);
            }
        }
    }

    /// Transfer underlying votes token and delegate in one atomic transaction.
    /// Only `from` must authorize this operation.
    pub fn transfer_and_delegate(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
        delegatee: Address,
    ) {
        from.require_auth();
        assert!(amount > 0, "amount must be positive");

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .expect("token not set");
        token::TokenClient::new(&env, &token_addr).transfer(&from, &to, &amount);
        Self::apply_delegation(&env, to, delegatee);
    }

    fn apply_delegation(env: &Env, delegator: Address, delegatee: Address) {
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .expect("token not set");
        let balance = token::TokenClient::new(env, &token_addr).balance(&delegator);

        // Determine whether this is a first-time delegation or a re-delegation.
        let previous_delegate: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Delegate(delegator.clone()));

        let record: DelegatorRecord = env
            .storage()
            .persistent()
            .get(&DataKey::DelegatorRecord(delegator.clone()))
            .unwrap_or_default();

        let current_ledger = env.ledger().sequence();
        let mut new_record = record.clone();
        new_record.balance = balance;

        if balance > record.balance {
            // Balance increased: average in the new tokens at current ledger
            let added = balance - record.balance;
            let total_weighted_start =
                (record.balance * record.start_ledger as i128) + (added * current_ledger as i128);
            new_record.start_ledger = if balance > 0 {
                (total_weighted_start / balance) as u32
            } else {
                current_ledger
            };
        } else if record.balance == 0 && balance > 0 {
            new_record.start_ledger = current_ledger;
        }
        // If balance decreased or stayed same, record.start_ledger is preserved.

        let old_weighted_sum = record.balance * record.start_ledger as i128;
        let new_weighted_sum = new_record.balance * new_record.start_ledger as i128;

        if let Some(old_delegatee) = previous_delegate.clone() {
            if old_delegatee != delegatee {
                Self::update_account_votes(env, old_delegatee.clone(), -record.balance, -old_weighted_sum);
                Self::update_account_votes(env, delegatee.clone(), new_record.balance, new_weighted_sum);
            } else {
                let delta = new_record.balance - record.balance;
                let delta_ws = new_weighted_sum - old_weighted_sum;
                Self::update_account_votes(env, delegatee.clone(), delta, delta_ws);
            }
            // Update total supply by the delta
            let delta = new_record.balance - record.balance;
            let delta_ws = new_weighted_sum - old_weighted_sum;
            if delta != 0 || delta_ws != 0 {
                Self::update_total_supply_checkpoint(env, delta, delta_ws);
            }
        } else {
            // First time delegation adds to total supply
            if balance > 0 {
                Self::update_total_supply_checkpoint(env, balance, new_weighted_sum);
            }
            Self::update_account_votes(env, delegatee.clone(), balance, new_weighted_sum);
        }

        env.storage()
            .persistent()
            .set(&DataKey::Delegate(delegator.clone()), &delegatee);
        env.storage()
            .persistent()
            .set(&DataKey::DelegatorRecord(delegator.clone()), &new_record);

        env.events().publish(
            (Symbol::new(env, "DelegateChanged"), delegator.clone()),
            (previous_delegate, delegatee),
        );
    }

    /// Revoke delegation and remove voting power from the previous delegatee.
    pub fn revoke_delegation(env: Env, delegator: Address) {
        delegator.require_auth();

        let previous_delegate: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::Delegate(delegator.clone()));

        if let Some(old_delegatee) = previous_delegate {
            let record: DelegatorRecord = env
                .storage()
                .persistent()
                .get(&DataKey::DelegatorRecord(delegator.clone()))
                .unwrap_or_default();

            let weighted_sum = record.balance * record.start_ledger as i128;
            if record.balance > 0 {
                // Remove voting power from the previous delegate and total supply.
                Self::update_account_votes(&env, old_delegatee.clone(), -record.balance, -weighted_sum);
                Self::update_total_supply_checkpoint(&env, -record.balance, -weighted_sum);
            }

            env.storage()
                .persistent()
                .remove(&DataKey::Delegate(delegator.clone()));
            env.storage()
                .persistent()
                .remove(&DataKey::DelegatorRecord(delegator.clone()));

            env.events().publish(
                (symbol_short!("del_revk"), delegator),
                (old_delegatee, record.balance),
            );
        }
    }

    /// Get the current delegatee of an account.
    pub fn delegates(env: Env, account: Address) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Delegate(account))
    }

    /// Get the delegator record (balance and start ledger) for an account.
    pub fn get_delegator_record(env: Env, account: Address) -> DelegatorRecord {
        env.storage()
            .persistent()
            .get(&DataKey::DelegatorRecord(account))
            .unwrap_or_default()
    }

    /// Get current voting power of an account.
    pub fn get_votes(env: Env, account: Address) -> i128 {
        let checkpoints: soroban_sdk::Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::Checkpoints(account))
            .unwrap_or(soroban_sdk::Vec::new(&env));
        if checkpoints.is_empty() {
            return 0;
        }
        let last = checkpoints.last().unwrap();

        if !Self::time_weight_enabled(env.clone()) {
            return last.votes;
        }

        let scale = Self::time_weight_scale(env.clone());
        let current_ledger = env.ledger().sequence();
        let bonus = (current_ledger as i128 * last.votes - last.weighted_sum) / scale as i128;
        last.votes + bonus
    }

    /// Get current base voting power (raw tokens) of an account.
    pub fn get_base_votes(env: Env, account: Address) -> i128 {
        let checkpoints: soroban_sdk::Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::Checkpoints(account))
            .unwrap_or(soroban_sdk::Vec::new(&env));
        if checkpoints.is_empty() {
            return 0;
        }
        checkpoints.last().unwrap().votes
    }

    /// Get the underlying token address.
    pub fn token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .expect("not initialized")
    }

    /// Get the admin address.
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    /// Get voting power at a past ledger sequence (snapshot).
    pub fn get_past_votes(env: Env, account: Address, ledger: u32) -> i128 {
        let current_ledger = env.ledger().sequence();
        assert!(ledger <= current_ledger, "ledger must not exceed current ledger");

        let checkpoints: soroban_sdk::Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::Checkpoints(account))
            .unwrap_or(soroban_sdk::Vec::new(&env));

        let cp = Self::binary_search(&checkpoints, ledger);
        if cp.votes <= 0 {
            return 0;
        }

        if !Self::time_weight_enabled(env.clone()) {
            return cp.votes;
        }

        let scale = Self::time_weight_scale(env.clone());
        let bonus = (ledger as i128 * cp.votes - cp.weighted_sum) / scale as i128;
        cp.votes + bonus
    }

    /// Get base voting power at a past ledger sequence.
    pub fn get_past_base_votes(env: Env, account: Address, ledger: u32) -> i128 {
        let checkpoints: soroban_sdk::Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::Checkpoints(account))
            .unwrap_or(soroban_sdk::Vec::new(&env));

        Self::binary_search(&checkpoints, ledger).votes
    }

    /// Get total delegated supply at a past ledger sequence.
    ///
    /// Performs a binary search over the total supply checkpoint log, returning
    /// the value recorded at or just before `ledger`. This is used by the
    /// governor to compute quorum as a fraction of the historical total supply.
    pub fn get_past_total_supply(env: Env, ledger: u32) -> i128 {
        let checkpoints: soroban_sdk::Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::TotalCheckpoints)
            .unwrap_or(soroban_sdk::Vec::new(&env));
        
        let cp = Self::binary_search(&checkpoints, ledger);
        if cp.votes <= 0 {
            return 0;
        }

        if !Self::time_weight_enabled(env.clone()) {
            return cp.votes;
        }

        let scale = Self::time_weight_scale(env.clone());
        let bonus = (ledger as i128 * cp.votes - cp.weighted_sum) / scale as i128;
        cp.votes + bonus
    }

    /// Write a checkpoint for an account. Called internally after balance changes.
    pub fn checkpoint(env: Env, account: Address, votes: i128) {
        let mut checkpoints: soroban_sdk::Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::Checkpoints(account.clone()))
            .unwrap_or(soroban_sdk::Vec::new(&env));

        let current_ledger = env.ledger().sequence();
        
        // When using raw checkpoint manually, we assume no weighted sum change for simplicity
        // or we try to estimate it based on last checkpoint.
        let weighted_sum = if checkpoints.is_empty() {
            votes * current_ledger as i128
        } else {
            let last = checkpoints.last().unwrap();
            let delta = votes - last.votes;
            last.weighted_sum + delta * current_ledger as i128
        };

        if !checkpoints.is_empty() && checkpoints.last().unwrap().ledger == current_ledger {
            let last_idx = checkpoints.len() - 1;
            checkpoints.set(
                last_idx,
                Checkpoint {
                    ledger: current_ledger,
                    votes,
                    weighted_sum,
                },
            );
        } else {
            checkpoints.push_back(Checkpoint {
                ledger: current_ledger,
                votes,
                weighted_sum,
            });
        }

        env.storage()
            .persistent()
            .set(&DataKey::Checkpoints(account), &checkpoints);
    }

    // --- Internal helpers ---

    /// Append or update the total supply checkpoint by `delta` at the current ledger.
    fn update_total_supply_checkpoint(env: &Env, delta: i128, delta_weighted_sum: i128) {
        let mut checkpoints: soroban_sdk::Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::TotalCheckpoints)
            .unwrap_or(soroban_sdk::Vec::new(env));
 
        let current_ledger = env.ledger().sequence();
        let (old_votes, old_weighted_sum) = if checkpoints.is_empty() {
            (0, 0)
        } else {
            let last = checkpoints.last().unwrap();
            (last.votes, last.weighted_sum)
        };
        let new_total = old_votes + delta;
        let new_weighted_sum = old_weighted_sum + delta_weighted_sum;
 
        if !checkpoints.is_empty() && checkpoints.last().unwrap().ledger == current_ledger {
            let last_idx = checkpoints.len() - 1;
            checkpoints.set(
                last_idx,
                Checkpoint {
                    ledger: current_ledger,
                    votes: new_total,
                    weighted_sum: new_weighted_sum,
                },
            );
        } else {
            checkpoints.push_back(Checkpoint {
                ledger: current_ledger,
                votes: new_total,
                weighted_sum: new_weighted_sum,
            });
        }
 
        env.storage()
            .persistent()
            .set(&DataKey::TotalCheckpoints, &checkpoints);
    }

    /// Update an account's voting power checkpoints by `delta`.
    /// Also registers the account in AccountList so it can be pruned later.
    fn update_account_votes(env: &Env, account: Address, delta: i128, delta_weighted_sum: i128) {
        let mut checkpoints: soroban_sdk::Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::Checkpoints(account.clone()))
            .unwrap_or(soroban_sdk::Vec::new(env));

        let current_ledger = env.ledger().sequence();
        let (old_votes, old_weighted_sum) = if checkpoints.is_empty() {
            (0, 0)
        } else {
            let last = checkpoints.last().unwrap();
            (last.votes, last.weighted_sum)
        };
        let new_votes = old_votes + delta;
        let new_weighted_sum = old_weighted_sum + delta_weighted_sum;

        if !checkpoints.is_empty() && checkpoints.last().unwrap().ledger == current_ledger {
            let last_idx = checkpoints.len() - 1;
            checkpoints.set(
                last_idx,
                Checkpoint {
                    ledger: current_ledger,
                    votes: new_votes,
                    weighted_sum: new_weighted_sum,
                },
            );
        } else {
            checkpoints.push_back(Checkpoint {
                ledger: current_ledger,
                votes: new_votes,
                weighted_sum: new_weighted_sum,
            });
        }

        env.storage()
            .persistent()
            .set(&DataKey::Checkpoints(account.clone()), &checkpoints);

        // Register account in the global list so prune_checkpoints can find it.
        // Only add if not already present (linear scan is acceptable since the
        // list grows slowly and is only read during admin pruning operations).
        let mut account_list: soroban_sdk::Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::AccountList)
            .unwrap_or(soroban_sdk::Vec::new(env));
        let already_registered = account_list.iter().any(|a| a == account);
        if !already_registered {
            account_list.push_back(account.clone());
            env.storage()
                .persistent()
                .set(&DataKey::AccountList, &account_list);
        }

        env.events()
            .publish((symbol_short!("v_active"), account), (old_votes, new_votes));
    }

    /// Binary search over an ordered checkpoint list.
    ///
    /// Returns the `votes` value of the latest checkpoint whose `ledger` field
    /// is \u2264 `target_ledger`, or 0 if no such checkpoint exists. The input Vec
    /// must be sorted in ascending ledger order (guaranteed by
    /// `update_total_supply_checkpoint`).
    fn binary_search(checkpoints: &soroban_sdk::Vec<Checkpoint>, target_ledger: u32) -> Checkpoint {
        if checkpoints.is_empty() {
            return Checkpoint {
                ledger: 0,
                votes: 0,
                weighted_sum: 0,
            };
        }

        let len = checkpoints.len();
        let mut low: u32 = 0;
        let mut high: u32 = len;

        // Invariant: the answer lies at checkpoints[low - 1] after convergence.
        while low < high {
            let mid = low + (high - low) / 2;
            let cp = checkpoints.get(mid).unwrap();
            if cp.ledger <= target_ledger {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        if low == 0 {
            return Checkpoint {
                ledger: 0,
                votes: 0,
                weighted_sum: 0,
            };
        }
        checkpoints.get(low - 1).unwrap()
    }

    /// Delegate voting power by signature (gasless for the token holder).
    ///
    /// Uses Soroban's native authorization framework (`owner.require_auth()`) to
    /// verify the delegation. This is the correct approach for Soroban contracts
    /// because Address types do not directly expose the underlying Ed25519 public
    /// key needed for manual `ed25519_verify` calls (see ADR-005).
    ///
    /// Replay protection is provided by the nonce (must equal the stored nonce,
    /// then incremented) and expiry (checked against current ledger timestamp).
    ///
    /// # Arguments
    /// * `owner`     - The token holder authorising the delegation
    /// * `delegatee` - The address to delegate voting power to
    /// * `nonce`     - Must equal the owner's current stored nonce
    /// * `expiry`    - Ledger timestamp after which the signature is invalid
    /// * `signature` - Ed25519 signature (verified via Soroban auth framework)
    pub fn delegate_by_sig(
        env: Env,
        owner: Address,
        delegatee: Address,
        nonce: u64,
        expiry: u64,
        _signature: BytesN<64>,
    ) {
        // Verify expiry against current ledger timestamp
        let current_time = env.ledger().timestamp();
        assert!(current_time <= expiry, "signature expired");

        // Verify and increment nonce (prevent replay)
        let nonce_key = DataKey::Nonce(owner.clone());
        let stored_nonce: u64 = env.storage().persistent().get(&nonce_key).unwrap_or(0);
        assert!(nonce == stored_nonce, "invalid nonce");
        env.storage()
            .persistent()
            .set(&nonce_key, &(stored_nonce + 1));

        // Use Soroban's native auth framework for signature verification.
        // This correctly handles Ed25519 keys, multisig, and smart-wallet accounts
        // without needing to extract the raw public key from an Address.
        owner.require_auth();
        Self::apply_delegation(&env, owner, delegatee);
    }

    /// Set the checkpoint retention period (admin only).
    pub fn set_checkpoint_retention_period(env: Env, period_ledgers: u32) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::CheckpointRetentionPeriod, &period_ledgers);

        env.events().publish(
            (symbol_short!("ret_set"),),
            (period_ledgers, env.ledger().sequence()),
        );
    }

    /// Get the current checkpoint retention period.
    pub fn checkpoint_retention_period(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::CheckpointRetentionPeriod)
            .unwrap_or(100800u32) // default ~2 weeks
    }

    /// Prune old checkpoints to reduce storage costs.
    /// Only removes checkpoints older than the retention period that are not needed by active proposals.
    /// Returns the number of checkpoints pruned.
    pub fn prune_checkpoints(env: Env, min_active_proposal_ledger: Option<u32>) -> u32 {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        let retention_period = Self::checkpoint_retention_period(env.clone());
        let current_ledger = env.ledger().sequence();
        let cutoff_ledger = current_ledger.saturating_sub(retention_period);

        // Ensure we don't prune checkpoints needed by active proposals
        let safe_cutoff = if let Some(min_ledger) = min_active_proposal_ledger {
            cutoff_ledger.min(min_ledger)
        } else {
            cutoff_ledger
        };

        let mut total_pruned = 0u32;

        // Prune total supply checkpoints
        total_pruned += Self::prune_total_supply_checkpoints(&env, safe_cutoff);

        // Prune individual account checkpoints
        total_pruned += Self::prune_account_checkpoints(&env, safe_cutoff);

        env.events().publish(
            (symbol_short!("pruned"),),
            (total_pruned, safe_cutoff, current_ledger),
        );

        total_pruned
    }

    /// Set whether time-weighted voting is enabled (admin only).
    pub fn set_time_weight_enabled(env: Env, enabled: bool) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        env.storage().instance().set(&DataKey::TimeWeightEnabled, &enabled);
    }

    /// Get whether time-weighted voting is enabled.
    pub fn time_weight_enabled(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::TimeWeightEnabled)
            .unwrap_or(false)
    }

    /// Set the time-weighted reward scale (admin only).
    pub fn set_time_weight_scale(env: Env, scale_ledgers: u32) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::TimeWeightScale, &scale_ledgers);
    }

    /// Get the current time-weighted reward scale.
    pub fn time_weight_scale(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::TimeWeightScale)
            .unwrap_or(4204800u32)
    }

    /// Prune total supply checkpoints older than cutoff_ledger.
    /// Returns the number of checkpoints pruned.
    fn prune_total_supply_checkpoints(env: &Env, cutoff_ledger: u32) -> u32 {
        let checkpoints: soroban_sdk::Vec<Checkpoint> = env
            .storage()
            .persistent()
            .get(&DataKey::TotalCheckpoints)
            .unwrap_or(soroban_sdk::Vec::new(env));

        if checkpoints.is_empty() {
            return 0;
        }

        let mut new_checkpoints = soroban_sdk::Vec::new(env);

        // Find the first checkpoint to keep (newer than cutoff_ledger)
        let mut start_idx = checkpoints.len();
        for i in 0..checkpoints.len() {
            let checkpoint = checkpoints.get(i).unwrap();
            if checkpoint.ledger > cutoff_ledger {
                start_idx = i;
                break;
            }
        }

        // Always keep at least the most recent checkpoint
        if start_idx == checkpoints.len() {
            start_idx = checkpoints.len() - 1;
        }

        // Copy checkpoints from start_idx to end
        for i in start_idx..checkpoints.len() {
            new_checkpoints.push_back(checkpoints.get(i).unwrap());
        }

        let pruned_count = start_idx.min(checkpoints.len() - 1);

        env.storage()
            .persistent()
            .set(&DataKey::TotalCheckpoints, &new_checkpoints);

        pruned_count
    }

    /// Prune individual account checkpoints older than cutoff_ledger.
    ///
    /// Iterates the AccountList registry (populated by update_account_votes) and
    /// removes stale checkpoints from each account's log. At least one checkpoint
    /// at or before the cutoff is always retained so that historical queries
    /// (get_past_votes) continue to return correct values.
    ///
    /// Returns the total number of checkpoints pruned across all accounts.
    fn prune_account_checkpoints(env: &Env, cutoff_ledger: u32) -> u32 {
        let account_list: soroban_sdk::Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::AccountList)
            .unwrap_or(soroban_sdk::Vec::new(env));

        let mut total_pruned = 0u32;

        for account in account_list.iter() {
            let checkpoints: soroban_sdk::Vec<Checkpoint> = env
                .storage()
                .persistent()
                .get(&DataKey::Checkpoints(account.clone()))
                .unwrap_or(soroban_sdk::Vec::new(env));

            if checkpoints.is_empty() {
                continue;
            }

            // Find the index of the first checkpoint strictly newer than cutoff.
            // We keep the checkpoint just before that index so historical queries
            // at or before cutoff_ledger still return the correct value.
            let mut keep_from: u32 = 0;
            for i in 0..checkpoints.len() {
                let cp = checkpoints.get(i).unwrap();
                if cp.ledger <= cutoff_ledger {
                    // This checkpoint is a candidate for pruning; the one after
                    // it (if any) is newer. We track the last one at/before cutoff
                    // so we can keep it as the "anchor" for historical queries.
                    keep_from = i;
                } else {
                    break;
                }
            }

            // keep_from is the index of the last checkpoint at/before cutoff.
            // We prune everything before keep_from (exclusive), retaining keep_from
            // as the historical anchor plus all newer checkpoints.
            if keep_from == 0 {
                // Either all checkpoints are newer than cutoff, or there is only
                // one checkpoint at/before cutoff \u2014 nothing to prune.
                continue;
            }

            let pruned_count = keep_from; // indices 0..keep_from are removed
            let mut new_checkpoints = soroban_sdk::Vec::new(env);
            for i in keep_from..checkpoints.len() {
                new_checkpoints.push_back(checkpoints.get(i).unwrap());
            }

            env.storage()
                .persistent()
                .set(&DataKey::Checkpoints(account), &new_checkpoints);

            total_pruned += pruned_count;
        }

        total_pruned
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger as _},
        token, Env,
    };

    /// Deploy a fresh token-votes contract backed by a real stellar asset contract.
    /// Returns (contract_id, token_address).
    fn setup(env: &Env, admin: &Address) -> (Address, Address) {
        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_addr = sac.address();
        let contract_id = env.register(TokenVotesContract, ());
        let client = TokenVotesContractClient::new(env, &contract_id);
        client.initialize(admin, &token_addr);
        (contract_id, token_addr)
    }

    #[test]
    fn test_first_delegation_adds_balance_to_total_supply() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        // Mint 1000 tokens to the delegator.
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator, &1000i128);

        // First delegation \u2014 total supply checkpoint should record the balance.
        client.delegate(&delegator, &delegatee);

        let total = client.get_past_total_supply(&env.ledger().sequence());
        assert_eq!(total, 1000);
    }

    #[test]
    fn test_redelegation_does_not_change_total_supply() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee1 = Address::generate(&env);
        let delegatee2 = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator, &500i128);

        // First delegation: activates voting power.
        client.delegate(&delegator, &delegatee1);
        let after_first = client.get_past_total_supply(&env.ledger().sequence());
        assert_eq!(after_first, 500);

        // Advance ledger so the re-delegation lands on a different slot.
        env.ledger().with_mut(|l| {
            l.sequence_number += 1;
        });

        // Re-delegation: power moves between delegatees; total must not change.
        client.delegate(&delegator, &delegatee2);
        let after_redelegate = client.get_past_total_supply(&env.ledger().sequence());
        assert_eq!(after_redelegate, 500);
    }

    #[test]
    fn test_multiple_delegators_accumulate_in_total_supply() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator1 = Address::generate(&env);
        let delegator2 = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator1, &300i128);
        sac_client.mint(&delegator2, &700i128);

        // Each delegator activates on a different ledger to produce distinct checkpoints.
        client.delegate(&delegator1, &delegatee);
        let after_first = client.get_past_total_supply(&env.ledger().sequence());
        assert_eq!(after_first, 300);

        env.ledger().with_mut(|l| {
            l.sequence_number += 1;
        });

        client.delegate(&delegator2, &delegatee);
        let after_second = client.get_past_total_supply(&env.ledger().sequence());
        assert_eq!(after_second, 1000); // 300 + 700
    }

    #[test]
    fn test_same_ledger_delegations_produce_single_checkpoint() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator1 = Address::generate(&env);
        let delegator2 = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator1, &400i128);
        sac_client.mint(&delegator2, &600i128);

        // Both delegations happen on the same ledger sequence \u2014 they should be
        // merged into a single checkpoint rather than producing two entries.
        client.delegate(&delegator1, &delegatee);
        client.delegate(&delegator2, &delegatee);

        // The combined total must reflect both balances.
        let total = client.get_past_total_supply(&env.ledger().sequence());
        assert_eq!(total, 1000); // 400 + 600

        // Only one checkpoint should exist because same-ledger entries are merged.
        let checkpoint_count = env.as_contract(&contract_id, || {
            let checkpoints: soroban_sdk::Vec<Checkpoint> = env
                .storage()
                .persistent()
                .get(&DataKey::TotalCheckpoints)
                .unwrap();
            checkpoints.len()
        });
        assert_eq!(checkpoint_count, 1);
    }

    #[test]
    fn test_binary_search_returns_correct_historical_value() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator1 = Address::generate(&env);
        let delegator2 = Address::generate(&env);
        let delegator3 = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator1, &100i128);
        sac_client.mint(&delegator2, &200i128);
        sac_client.mint(&delegator3, &300i128);

        // ledger 1: total = 100
        env.ledger().with_mut(|l| {
            l.sequence_number = 1;
        });
        client.delegate(&delegator1, &delegatee);

        // ledger 5: total = 300
        env.ledger().with_mut(|l| {
            l.sequence_number = 5;
        });
        client.delegate(&delegator2, &delegatee);

        // ledger 10: total = 600
        env.ledger().with_mut(|l| {
            l.sequence_number = 10;
        });
        client.delegate(&delegator3, &delegatee);

        // Exact ledger matches.
        assert_eq!(client.get_past_total_supply(&1), 100);
        assert_eq!(client.get_past_total_supply(&5), 300);
        assert_eq!(client.get_past_total_supply(&10), 600);

        // Between checkpoints: return the most recent value before the query.
        assert_eq!(client.get_past_total_supply(&3), 100); // between ledger 1 and 5
        assert_eq!(client.get_past_total_supply(&7), 300); // between ledger 5 and 10
        assert_eq!(client.get_past_total_supply(&99), 600); // after last checkpoint

        // Before any checkpoint: return 0.
        assert_eq!(client.get_past_total_supply(&0), 0);
    }

    #[test]
    fn test_delegation_transfers_voting_power() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee1 = Address::generate(&env);
        let delegatee2 = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator, &1000i128);

        // First delegation
        client.delegate(&delegator, &delegatee1);
        assert_eq!(client.get_votes(&delegatee1), 1000);
        assert_eq!(client.get_votes(&delegatee2), 0);

        env.ledger().with_mut(|l| {
            l.sequence_number += 1;
        });

        // Redelegation
        client.delegate(&delegator, &delegatee2);
        assert_eq!(client.get_votes(&delegatee1), 0);
        assert_eq!(client.get_votes(&delegatee2), 1000);
    }

    #[test]
    fn test_revoke_delegation_removes_voting_power_and_emits_event() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator, &500i128);

        client.delegate(&delegator, &delegatee);
        assert_eq!(client.get_votes(&delegatee), 500);
        assert_eq!(client.delegates(&delegator), Some(delegatee.clone()));
        assert_eq!(client.get_past_total_supply(&env.ledger().sequence()), 500);

        env.ledger().with_mut(|l| l.sequence_number += 1);
        client.revoke_delegation(&delegator);

        assert_eq!(client.get_votes(&delegatee), 0);
        assert_eq!(client.delegates(&delegator), None);
        assert_eq!(client.get_past_total_supply(&env.ledger().sequence()), 0);
    }

    #[test]
    fn test_delegation_emits_events() {
        use soroban_sdk::TryIntoVal as _;
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator, &1000i128);

        client.delegate(&delegator, &delegatee);

        let events = env.events().all();
        let mut sub_events: soroban_sdk::Vec<_> = soroban_sdk::Vec::new(&env);
        for event in events.iter() {
            if event.0 == contract_id {
                sub_events.push_back(event.clone());
            }
        }
        assert!(sub_events.len() >= 2);

        // The last contract event must be the canonical DelegateChanged event
        // with the delegator as the second topic element (issue #460).
        let delegate_changed = sub_events.last().unwrap();
        let topic_0: Result<Symbol, _> = delegate_changed.1.get(0).unwrap().try_into_val(&env);
        assert!(topic_0.is_ok());
        assert_eq!(topic_0.unwrap(), Symbol::new(&env, "DelegateChanged"));
        let topic_1: Result<Address, _> = delegate_changed.1.get(1).unwrap().try_into_val(&env);
        assert_eq!(topic_1.unwrap(), delegator);
    }

    #[test]
    fn test_account_binary_search_returns_correct_historical_value() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let user1 = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&user1, &1000i128);

        // ledger 1: user1 delegations = 1000
        env.ledger().with_mut(|l| {
            l.sequence_number = 1;
        });
        client.delegate(&user1, &user1);
        assert_eq!(client.get_past_votes(&user1, &1), 1000);

        // ledger 10: user1 delegations = 1500
        env.ledger().with_mut(|l| {
            l.sequence_number = 10;
        });
        sac_client.mint(&user1, &500i128);
        // We must call checkpoint or delegate to update the voting power log.
        // In a real scenario, the token contract would call this.
        client.checkpoint(&user1, &1500i128);
        assert_eq!(client.get_votes(&user1), 1500);
        assert_eq!(client.get_past_votes(&user1, &10), 1500);

        // ledger 20: user1 delegations = 1300
        env.ledger().with_mut(|l| {
            l.sequence_number = 20;
        });
        client.checkpoint(&user1, &1300i128);
        assert_eq!(client.get_votes(&user1), 1300);
        assert_eq!(client.get_past_votes(&user1, &20), 1300);

        // Verify history
        assert_eq!(client.get_past_votes(&user1, &0), 0);
        assert_eq!(client.get_past_votes(&user1, &5), 1000);
        assert_eq!(client.get_past_votes(&user1, &10), 1500);
        assert_eq!(client.get_past_votes(&user1, &15), 1500);
        assert_eq!(client.get_past_votes(&user1, &20), 1300);
        assert_eq!(client.get_past_votes(&user1, &100), 1300);
    }

    #[test]
    #[should_panic(expected = "ledger must not exceed current ledger")]
    fn test_get_past_votes_panics_on_future_ledger() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user1 = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&user1, &1000i128);
        env.ledger().with_mut(|l| {
            l.sequence_number = 1;
        });
        client.delegate(&user1, &user1);

        let current_ledger = env.ledger().sequence();
        client.get_past_votes(&user1, &(current_ledger + 1));
    }

    // \u2014\u2014 Edge-case tests (issue #192) \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014

    /// Zero-balance delegators must not contribute to the total delegated supply
    /// because the on-chain guard skips `update_total_supply_checkpoint` when
    /// `balance == 0`.
    #[test]
    fn test_zero_balance_delegation_does_not_affect_total_supply() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let zero_holder = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, _token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        // zero_holder has no tokens \u2014 total supply must stay 0 after delegation.
        client.delegate(&zero_holder, &delegatee);

        assert_eq!(client.get_votes(&delegatee), 0);
        assert_eq!(client.get_past_total_supply(&env.ledger().sequence()), 0);
    }

    /// Self-delegation: delegating to your own address is a valid operation.
    /// The delegator's balance should appear as their own voting power.
    #[test]
    fn test_self_delegation_grants_own_voting_power() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&user, &2000i128);
        client.delegate(&user, &user); // delegate to self

        assert_eq!(client.get_votes(&user), 2000);
        assert_eq!(client.get_past_total_supply(&env.ledger().sequence()), 2000);
    }

    #[test]
    fn test_transfer_and_delegate_success() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&from, &500i128);
        client.transfer_and_delegate(&from, &to, &200i128, &delegatee);

        let token_client = token::TokenClient::new(&env, &token_addr);
        assert_eq!(token_client.balance(&from), 300);
        assert_eq!(token_client.balance(&to), 200);
        assert_eq!(client.delegates(&to), Some(delegatee.clone()));
        assert_eq!(client.get_votes(&delegatee), 200);
        assert_eq!(client.get_past_total_supply(&env.ledger().sequence()), 200);
    }

    #[test]
    #[should_panic]
    fn test_transfer_and_delegate_insufficient_balance_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&from, &50i128);
        client.transfer_and_delegate(&from, &to, &200i128, &delegatee);
    }

    #[test]
    fn test_transfer_and_delegate_self_delegation() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let from = Address::generate(&env);
        let to = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&from, &1000i128);
        client.transfer_and_delegate(&from, &to, &400i128, &to);

        assert_eq!(client.delegates(&to), Some(to.clone()));
        assert_eq!(client.get_votes(&to), 400);
        assert_eq!(client.get_past_total_supply(&env.ledger().sequence()), 400);
    }

    /// Re-delegating to the *same* delegatee is a no-op: voting power must not
    /// double-count and the total supply must remain unchanged.
    #[test]
    fn test_redelegation_to_same_delegatee_is_noop() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&delegator, &500i128);
        client.delegate(&delegator, &delegatee);

        env.ledger().with_mut(|l| {
            l.sequence_number += 1;
        });

        // Re-delegate to the same address \u2014 should be a no-op.
        client.delegate(&delegator, &delegatee);

        assert_eq!(client.get_votes(&delegatee), 500);
        assert_eq!(client.get_past_total_supply(&env.ledger().sequence()), 500);
    }

    /// `get_votes` on an account that has never been delegated to must return 0.
    #[test]
    fn test_get_votes_before_any_delegation_returns_zero() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let nobody = Address::generate(&env);

        let (contract_id, _token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        assert_eq!(client.get_votes(&nobody), 0);
        assert_eq!(client.get_past_votes(&nobody, &env.ledger().sequence()), 0);
    }

    /// Multiple sequential re-delegations: voting power must follow the chain
    /// A\u2192B\u2192C\u2192D correctly \u2014 each previous delegatee loses and the new one gains.
    #[test]
    fn test_multiple_sequential_redelegations() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&delegator, &1000i128);

        env.ledger().with_mut(|l| {
            l.sequence_number = 10;
        });
        client.delegate(&delegator, &a);
        assert_eq!(client.get_votes(&a), 1000);

        env.ledger().with_mut(|l| {
            l.sequence_number = 20;
        });
        client.delegate(&delegator, &b);
        assert_eq!(client.get_votes(&a), 0);
        assert_eq!(client.get_votes(&b), 1000);

        env.ledger().with_mut(|l| {
            l.sequence_number = 30;
        });
        client.delegate(&delegator, &c);
        assert_eq!(client.get_votes(&b), 0);
        assert_eq!(client.get_votes(&c), 1000);

        // Total supply must remain 1000 throughout.
        assert_eq!(client.get_past_total_supply(&30), 1000);

        // Historical snapshots must be accurate for each step.
        assert_eq!(client.get_past_votes(&a, &15), 1000); // while delegated to a
        assert_eq!(client.get_past_votes(&a, &25), 0); // after delegation moved to b
        assert_eq!(client.get_past_votes(&b, &25), 1000); // while delegated to b
        assert_eq!(client.get_past_votes(&b, &35), 0); // after delegation moved to c
    }

    /// Checkpoint boundary conditions: querying at exactly the checkpoint ledger,
    /// one ledger before, and one ledger after must all return the correct value.
    #[test]
    fn test_checkpoint_boundary_conditions() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&delegator, &100i128);

        // Checkpoint is written at ledger 50.
        env.ledger().with_mut(|l| {
            l.sequence_number = 50;
        });
        client.delegate(&delegator, &delegatee);

        // Exactly at the checkpoint ledger \u2014 must return the recorded value.
        assert_eq!(client.get_past_votes(&delegatee, &50), 100);

        // One ledger before the checkpoint \u2014 no data yet, must return 0.
        assert_eq!(client.get_past_votes(&delegatee, &49), 0);

        // One ledger after the checkpoint \u2014 the last checkpoint still applies.
        assert_eq!(client.get_past_votes(&delegatee, &51), 100);
    }

    /// Voting power at the exact proposal start block mirrors the governor's
    /// quorum snapshot: `get_past_votes` at `proposal.start_ledger` must equal
    /// the delegatee's power at that point, unaffected by later delegations.
    #[test]
    fn test_voting_power_at_exact_proposal_start_ledger() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let delegatee = Address::generate(&env);
        let new_delegator = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&delegator, &800i128);
        sac_client.mint(&new_delegator, &200i128);

        // Snapshot ledger: delegatee has 800 power.
        let proposal_start: u32 = 100;
        env.ledger().with_mut(|l| {
            l.sequence_number = proposal_start;
        });
        client.delegate(&delegator, &delegatee);

        // After the snapshot, a new delegation adds 200 more power to delegatee.
        env.ledger().with_mut(|l| {
            l.sequence_number = proposal_start + 10;
        });
        client.delegate(&new_delegator, &delegatee);

        // Current votes now include both delegators.
        assert_eq!(client.get_votes(&delegatee), 1000);

        // Historical query at proposal_start must reflect only the 800 that
        // existed when the proposal was created \u2014 not the later 200.
        assert_eq!(client.get_past_votes(&delegatee, &proposal_start), 800);
    }

    /// Pseudo-fuzz: iterate over a range of token amounts and verify that the
    /// total delegated supply always equals the sum of all individual balances.
    #[test]
    fn test_fuzz_total_supply_equals_sum_of_delegated_balances() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        // Use prime-ish amounts to surface any off-by-one aggregation bugs.
        let amounts: [i128; 8] = [1, 7, 13, 97, 101, 503, 1009, 9973];
        let mut expected_total: i128 = 0;

        for (i, &amount) in amounts.iter().enumerate() {
            let delegator = Address::generate(&env);
            sac_client.mint(&delegator, &amount);

            // Advance ledger so each delegation lands on a distinct checkpoint.
            env.ledger().with_mut(|l| {
                l.sequence_number = ((i as u32) + 1) * 10;
            });
            client.delegate(&delegator, &delegatee);

            expected_total += amount;
            let actual_total = client.get_past_total_supply(&env.ledger().sequence());
            assert_eq!(
                actual_total, expected_total,
                "total supply mismatch after delegating {} (step {})",
                amount, i
            );
        }

        // Delegatee's voting power must also equal the accumulated total.
        assert_eq!(client.get_votes(&delegatee), expected_total);
    }

    /// Same-ledger re-delegation must merge checkpoints \u2014 no duplicate entries
    /// and the final votes value must be accurate.
    #[test]
    fn test_same_ledger_redelegation_merges_checkpoints() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        sac_client.mint(&delegator, &300i128);

        // First delegation to `a` at ledger 5.
        env.ledger().with_mut(|l| {
            l.sequence_number = 5;
        });
        client.delegate(&delegator, &a);

        // Re-delegate to `b` on the *same* ledger \u2014 `a` and `b` checkpoints at
        // ledger 5 must each be a single merged entry, not duplicate rows.
        client.delegate(&delegator, &b);

        assert_eq!(client.get_votes(&a), 0);
        assert_eq!(client.get_votes(&b), 300);

        // Verify checkpoint counts via direct storage inspection.
        let (a_count, b_count) = env.as_contract(&contract_id, || {
            let a_cps: soroban_sdk::Vec<Checkpoint> = env
                .storage()
                .persistent()
                .get(&DataKey::Checkpoints(a.clone()))
                .unwrap_or(soroban_sdk::Vec::new(&env));
            let b_cps: soroban_sdk::Vec<Checkpoint> = env
                .storage()
                .persistent()
                .get(&DataKey::Checkpoints(b.clone()))
                .unwrap_or(soroban_sdk::Vec::new(&env));
            (a_cps.len(), b_cps.len())
        });

        assert_eq!(a_count, 1, "a should have exactly one merged checkpoint");
        assert_eq!(b_count, 1, "b should have exactly one checkpoint");
    }

    #[test]
    fn test_set_checkpoint_retention_period() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let (contract_id, _) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        // Default retention period should be 100800
        assert_eq!(client.checkpoint_retention_period(), 100800);

        // Set new retention period
        client.set_checkpoint_retention_period(&50000u32);
        assert_eq!(client.checkpoint_retention_period(), 50000);
    }

    // \u2014\u2014 prune_checkpoints tests (issue #217) \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014

    /// Pruning removes stale per-account checkpoints while keeping the anchor.
    #[test]
    fn test_prune_account_checkpoints_removes_stale_entries() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator, &1000i128);

        // Create checkpoints at ledgers 10, 20, 30, 40 by re-delegating to
        // different delegatees each time (same delegatee is a no-op).
        let d1 = Address::generate(&env);
        let d2 = Address::generate(&env);
        let d3 = Address::generate(&env);
        let d4 = Address::generate(&env);

        env.ledger().with_mut(|l| l.sequence_number = 10);
        client.delegate(&delegator, &d1);

        env.ledger().with_mut(|l| l.sequence_number = 20);
        client.delegate(&delegator, &d2);

        env.ledger().with_mut(|l| l.sequence_number = 30);
        client.delegate(&delegator, &d3);

        env.ledger().with_mut(|l| l.sequence_number = 40);
        client.delegate(&delegator, &d4);

        // d4 now has 4 checkpoints (gained at 40, d3 lost at 30\u219240, etc.)
        // Actually each delegatee gets one checkpoint. d1 has checkpoints at 10 and 20 (gain then lose).

        // Set retention period to 15 ledgers; current ledger = 40
        // cutoff = 40 - 15 = 25 \u2192 checkpoints at ledger \u2264 25 are candidates
        // d1 has checkpoints at 10 (+1000) and 20 (0) \u2014 ledger 20 is the anchor, ledger 10 is pruned
        client.set_checkpoint_retention_period(&15u32);
        env.ledger().with_mut(|l| l.sequence_number = 40);

        let pruned = client.prune_checkpoints(&None);
        assert!(pruned > 0, "expected pruned > 0, got {}", pruned);

        // Historical query at ledger 20 (the anchor for d1) must still work
        assert_eq!(client.get_past_votes(&d1, &20), 0);
        // d4 still has current votes
        assert_eq!(client.get_votes(&d4), 1000);
    }

    /// After pruning, historical queries at the cutoff boundary still return correct values.
    #[test]
    fn test_prune_preserves_historical_query_correctness() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegator1 = Address::generate(&env);
        let delegator2 = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&delegator1, &500i128);
        sac_client.mint(&delegator2, &300i128);

        // ledger 5: delegator1 delegates \u2192 delegatee has 500
        env.ledger().with_mut(|l| l.sequence_number = 5);
        client.delegate(&delegator1, &delegatee);

        // ledger 50: delegator2 delegates \u2192 delegatee has 800
        env.ledger().with_mut(|l| l.sequence_number = 50);
        client.delegate(&delegator2, &delegatee);

        // ledger 100: prune with retention=30 \u2192 cutoff=70
        // checkpoint at ledger 5 is the anchor (last at/before 70), kept
        // checkpoint at ledger 50 is also at/before 70, so ledger 5 is pruned
        env.ledger().with_mut(|l| l.sequence_number = 100);
        client.set_checkpoint_retention_period(&30u32);
        client.prune_checkpoints(&None);

        // Query at ledger 50 (the anchor after pruning) must still be correct
        assert_eq!(client.get_past_votes(&delegatee, &50), 800);
        // Current votes unchanged
        assert_eq!(client.get_votes(&delegatee), 800);
    }

    /// prune_checkpoints returns the actual count of pruned entries.
    #[test]
    fn test_prune_returns_correct_count() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);

        // Create 5 delegators each at a different ledger
        for i in 1u32..=5 {
            let delegator = Address::generate(&env);
            sac_client.mint(&delegator, &100i128);
            env.ledger().with_mut(|l| l.sequence_number = i * 10);
            client.delegate(&delegator, &delegatee);
        }

        // At ledger 60, retention=15 \u2192 cutoff=45
        // Per-account: each delegatee checkpoint at ledger \u2264 45 has candidates
        // Total supply also has stale entries
        env.ledger().with_mut(|l| l.sequence_number = 60);
        client.set_checkpoint_retention_period(&15u32);

        let pruned = client.prune_checkpoints(&None);
        assert!(pruned > 0, "expected some checkpoints pruned");
    }

    // \u2014\u2014 delegate_by_sig tests (issue #216) \u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014

    /// Valid delegation via delegate_by_sig: correct nonce, unexpired, auth passes.
    #[test]
    fn test_delegate_by_sig_valid() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let owner = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&owner, &1000i128);

        // Set ledger timestamp so expiry is in the future
        env.ledger().with_mut(|l| l.timestamp = 100);

        let nonce = 0u64;
        let expiry = 200u64;
        let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);

        client.delegate_by_sig(&owner, &delegatee, &nonce, &expiry, &dummy_sig);

        // Delegation should have been applied
        assert_eq!(client.get_votes(&delegatee), 1000);
        assert_eq!(client.delegates(&owner), Some(delegatee.clone()));
    }

    /// Expired signature must be rejected.
    #[test]
    #[should_panic(expected = "signature expired")]
    fn test_delegate_by_sig_expired() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let owner = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, _) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);

        env.ledger().with_mut(|l| l.timestamp = 500);

        let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);
        // expiry is in the past
        client.delegate_by_sig(&owner, &delegatee, &0u64, &100u64, &dummy_sig);
    }

    /// Replayed nonce must be rejected.
    #[test]
    #[should_panic(expected = "invalid nonce")]
    fn test_delegate_by_sig_replayed_nonce() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let owner = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&owner, &500i128);

        env.ledger().with_mut(|l| l.timestamp = 100);
        let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);

        // First call with nonce=0 succeeds
        client.delegate_by_sig(&owner, &delegatee, &0u64, &9999u64, &dummy_sig);

        // Second call with nonce=0 must fail (nonce is now 1)
        client.delegate_by_sig(&owner, &delegatee, &0u64, &9999u64, &dummy_sig);
    }

    /// Nonce is incremented after a successful delegate_by_sig call.
    #[test]
    fn test_delegate_by_sig_nonce_increments() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let owner = Address::generate(&env);
        let delegatee1 = Address::generate(&env);
        let delegatee2 = Address::generate(&env);

        let (contract_id, token_addr) = setup(&env, &admin);
        let client = TokenVotesContractClient::new(&env, &contract_id);
        let sac_client = token::StellarAssetClient::new(&env, &token_addr);
        sac_client.mint(&owner, &300i128);

        env.ledger().with_mut(|l| l.timestamp = 1);
        let dummy_sig = BytesN::from_array(&env, &[0u8; 64]);

        // nonce=0 succeeds
        client.delegate_by_sig(&owner, &delegatee1, &0u64, &9999u64, &dummy_sig);
        assert_eq!(client.get_votes(&delegatee1), 300);

        env.ledger().with_mut(|l| l.sequence_number += 1);

        // nonce=1 succeeds (re-delegation)
        client.delegate_by_sig(&owner, &delegatee2, &1u64, &9999u64, &dummy_sig);
        assert_eq!(client.get_votes(&delegatee1), 0);
        assert_eq!(client.get_votes(&delegatee2), 300);
    }

}

#[cfg(test)]
mod invariant_tests;
