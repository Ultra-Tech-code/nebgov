#![no_std]
#![allow(clippy::too_many_arguments)]

use soroban_sdk::xdr::{FromXdr, ToXdr};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Bytes, Env, Symbol,
    Val, Vec,
};

/// Absolute minimum delay in seconds that the admin is allowed to set.
const MIN_DELAY: u64 = 86_400;

/// Timelock error codes.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimelockError {
    /// Operation has not yet been executed but is required as a predecessor.
    PredecessorNotDone = 1,
    /// Operation references a predecessor operation that does not exist.
    PredecessorNotFound = 2,
    /// Operation can no longer be executed because its execution window elapsed.
    OperationExpired = 3,
    /// New delay is below the absolute minimum allowed.
    DelayTooShort = 4,
}

/// A scheduled timelock operation.
#[contracttype]
#[derive(Clone)]
pub struct Operation {
    pub target: Address,
    pub data: Bytes,
    pub fn_name: Symbol,
    pub ready_at: u64,
    pub expires_at: u64,
    pub executed: bool,
    pub cancelled: bool,
    pub predecessor: Bytes,
}

/// A scheduled batch timelock operation.
///
/// Stores all sub-operations under a single `batch_op_id`.  Execution is
/// all-or-nothing: if any sub-call panics, the entire batch reverts.
#[contracttype]
#[derive(Clone)]
pub struct BatchOperation {
    pub targets: Vec<Address>,
    pub datas: Vec<Bytes>,
    pub fn_names: Vec<Symbol>,
    pub ready_at: u64,
    pub expires_at: u64,
    pub executed: bool,
    pub cancelled: bool,
    pub predecessor: Bytes,
}

#[contracttype]
pub enum DataKey {
    Operation(Bytes),
    BatchOperation(Bytes),
    MinDelay,
    ExecutionWindow,
    Admin,
    Governor,
}

#[contract]
pub struct TimelockContract;

#[contractimpl]
impl TimelockContract {
    /// Initialize timelock with minimum delay, execution window, admin, and governor.
    pub fn initialize(
        env: Env,
        admin: Address,
        governor: Address,
        min_delay: u64,
        execution_window: u64,
    ) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Governor, &governor);
        env.storage().instance().set(&DataKey::MinDelay, &min_delay);
        env.storage()
            .instance()
            .set(&DataKey::ExecutionWindow, &execution_window);
    }

    /// Compute operation ID from target, data, predecessor, and salt.
    pub fn compute_op_id(
        env: Env,
        target: Address,
        data: Bytes,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes {
        let mut combined = Bytes::new(&env);
        combined.append(&target.to_xdr(&env));
        combined.append(&data);
        combined.append(&predecessor);
        combined.append(&salt);

        let hash = env.crypto().sha256(&combined);
        Bytes::from_array(&env, &hash.to_array())
    }

    /// Compute a deterministic batch op_id from all sub-operation tuples combined
    /// with a single predecessor and salt.
    ///
    /// Same inputs always produce the same ID, so scheduling is idempotent.
    pub fn compute_batch_op_id(
        env: Env,
        targets: Vec<Address>,
        datas: Vec<Bytes>,
        fn_names: Vec<Symbol>,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes {
        let mut combined = Bytes::new(&env);
        for i in 0..targets.len() {
            combined.append(&targets.get(i).unwrap().to_xdr(&env));
            combined.append(&datas.get(i).unwrap());
            combined.append(&fn_names.get(i).unwrap().to_xdr(&env));
        }
        combined.append(&predecessor);
        combined.append(&salt);

        let hash = env.crypto().sha256(&combined);
        Bytes::from_array(&env, &hash.to_array())
    }

    /// Schedule a single operation.
    #[allow(clippy::too_many_arguments)]
    pub fn schedule(
        env: Env,
        caller: Address,
        target: Address,
        data: Bytes,
        fn_name: Symbol,
        delay: u64,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes {
        caller.require_auth();
        Self::require_governor(&env, &caller);
        Self::schedule_operation(env, target, data, fn_name, delay, predecessor, salt)
    }

    /// Schedule multiple operations as a single atomic batch.
    ///
    /// Unlike the previous N-op-id design, this returns **one** `batch_op_id`
    /// covering all sub-operations.  Use [`execute_batch`] to run them all at
    /// once.  A single `predecessor` and `salt` apply to the whole batch.
    #[allow(clippy::too_many_arguments)]
    pub fn schedule_batch(
        env: Env,
        caller: Address,
        targets: Vec<Address>,
        datas: Vec<Bytes>,
        fn_names: Vec<Symbol>,
        delay: u64,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        let len = targets.len();
        assert!(len > 0, "empty batch");
        assert!(len == datas.len(), "length mismatch");
        assert!(len == fn_names.len(), "length mismatch");

        Self::validate_predecessor(&env, &predecessor);

        let min_delay = Self::min_delay(env.clone());
        assert!(delay >= min_delay, "delay too short");

        let execution_window = Self::execution_window(env.clone());
        let ready_at = env.ledger().timestamp() + delay;
        let expires_at = ready_at + execution_window;

        let batch_op_id = Self::compute_batch_op_id(
            env.clone(),
            targets.clone(),
            datas.clone(),
            fn_names.clone(),
            predecessor.clone(),
            salt,
        );

        let batch = BatchOperation {
            targets,
            datas,
            fn_names,
            ready_at,
            expires_at,
            executed: false,
            cancelled: false,
            predecessor,
        };

        env.storage()
            .persistent()
            .set(&DataKey::BatchOperation(batch_op_id.clone()), &batch);

        env.events()
            .publish((symbol_short!("schbatch"),), batch_op_id.clone());

        batch_op_id
    }

    /// Execute a ready operation.
    pub fn execute(env: Env, caller: Address, op_id: Bytes) {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        let mut op: Operation = env
            .storage()
            .persistent()
            .get(&DataKey::Operation(op_id.clone()))
            .expect("operation not found");

        assert!(!op.executed && !op.cancelled, "invalid state");
        assert!(env.ledger().timestamp() >= op.ready_at, "not ready");
        if env.ledger().timestamp() > op.expires_at {
            env.panic_with_error(TimelockError::OperationExpired);
        }

        if !op.predecessor.is_empty() {
            let pred_done = Self::is_done(env.clone(), op.predecessor.clone())
                || Self::is_batch_done(env.clone(), op.predecessor.clone());
            if !pred_done {
                env.panic_with_error(TimelockError::PredecessorNotDone);
            }
        }

        op.executed = true;
        env.storage()
            .persistent()
            .set(&DataKey::Operation(op_id.clone()), &op);

        let args = Self::decode_invocation_args(&env, &op.data);
        env.invoke_contract::<()>(&op.target, &op.fn_name, args);

        env.events().publish((symbol_short!("execute"),), op_id);
    }

    /// Execute a batch of operations atomically under a single `batch_op_id`.
    ///
    /// All sub-calls run in order.  If any sub-call panics, the entire
    /// transaction reverts and none of the sub-calls take effect.
    pub fn execute_batch(env: Env, caller: Address, batch_op_id: Bytes) {
        caller.require_auth();
        Self::require_governor(&env, &caller);

        let mut batch: BatchOperation = env
            .storage()
            .persistent()
            .get(&DataKey::BatchOperation(batch_op_id.clone()))
            .expect("batch not found");

        assert!(!batch.executed && !batch.cancelled, "invalid state");
        assert!(env.ledger().timestamp() >= batch.ready_at, "not ready");
        if env.ledger().timestamp() > batch.expires_at {
            env.panic_with_error(TimelockError::OperationExpired);
        }

        if !batch.predecessor.is_empty() {
            let pred_done = Self::is_done(env.clone(), batch.predecessor.clone())
                || Self::is_batch_done(env.clone(), batch.predecessor.clone());
            if !pred_done {
                env.panic_with_error(TimelockError::PredecessorNotDone);
            }
        }

        batch.executed = true;
        env.storage()
            .persistent()
            .set(&DataKey::BatchOperation(batch_op_id.clone()), &batch);

        for i in 0..batch.targets.len() {
            let target = batch.targets.get(i).unwrap();
            let fn_name = batch.fn_names.get(i).unwrap();
            let data = batch.datas.get(i).unwrap();
            let args = Self::decode_invocation_args(&env, &data);
            env.invoke_contract::<()>(&target, &fn_name, args);
        }

        env.events()
            .publish((symbol_short!("exbatch"),), batch_op_id);
    }

    /// Cancel a pending operation or batch operation.
    pub fn cancel(env: Env, caller: Address, op_id: Bytes) {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        let governor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized");
        assert!(caller == admin || caller == governor, "not authorized");

        // Try single operation first, then batch operation.
        if let Some(mut op) = env
            .storage()
            .persistent()
            .get::<_, Operation>(&DataKey::Operation(op_id.clone()))
        {
            assert!(!op.executed && !op.cancelled, "invalid state");
            op.cancelled = true;
            env.storage()
                .persistent()
                .set(&DataKey::Operation(op_id.clone()), &op);
        } else if let Some(mut batch) = env
            .storage()
            .persistent()
            .get::<_, BatchOperation>(&DataKey::BatchOperation(op_id.clone()))
        {
            assert!(!batch.executed && !batch.cancelled, "invalid state");
            batch.cancelled = true;
            env.storage()
                .persistent()
                .set(&DataKey::BatchOperation(op_id.clone()), &batch);
        } else {
            panic!("operation not found");
        }

        env.events().publish((symbol_short!("cancel"),), op_id);
    }

    /// Check whether an operation is pending.
    pub fn is_pending(env: Env, op_id: Bytes) -> bool {
        let op: Option<Operation> = env.storage().persistent().get(&DataKey::Operation(op_id));
        match op {
            Some(op) => !op.executed && !op.cancelled && env.ledger().timestamp() < op.ready_at,
            None => false,
        }
    }

    /// Check whether an operation is ready.
    pub fn is_ready(env: Env, op_id: Bytes) -> bool {
        let op: Option<Operation> = env.storage().persistent().get(&DataKey::Operation(op_id));
        match op {
            Some(op) => {
                !op.executed
                    && !op.cancelled
                    && env.ledger().timestamp() >= op.ready_at
                    && env.ledger().timestamp() <= op.expires_at
            }
            None => false,
        }
    }

    /// Check whether an operation has been executed.
    pub fn is_done(env: Env, op_id: Bytes) -> bool {
        let op: Option<Operation> = env.storage().persistent().get(&DataKey::Operation(op_id));
        match op {
            Some(op) => op.executed,
            None => false,
        }
    }

    /// Check whether a batch operation has been executed.
    pub fn is_batch_done(env: Env, batch_op_id: Bytes) -> bool {
        let batch: Option<BatchOperation> = env
            .storage()
            .persistent()
            .get(&DataKey::BatchOperation(batch_op_id));
        match batch {
            Some(b) => b.executed,
            None => false,
        }
    }

    /// Get the configured minimum delay in seconds.
    pub fn min_delay(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::MinDelay)
            .unwrap_or(86_400)
    }

    /// Get the configured execution window in seconds.
    pub fn execution_window(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ExecutionWindow)
            .unwrap_or(1_209_600)
    }

    /// Get the configured governor address.
    pub fn governor(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized")
    }

    /// Get the configured admin address.
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    /// Update the minimum delay. Only admin.
    pub fn update_delay(env: Env, caller: Address, new_delay: u64) {
        caller.require_auth();
        assert!(caller == Self::admin(env.clone()), "only admin");
        if new_delay < MIN_DELAY {
            env.panic_with_error(TimelockError::DelayTooShort);
        }
        let old_delay: u64 = env.storage().instance().get(&DataKey::MinDelay).unwrap_or(86400);
        env.storage().instance().set(&DataKey::MinDelay, &new_delay);
        env.events().publish(
            (symbol_short!("upd_dly"),),
            (old_delay, new_delay),
        );
    }

    /// Update the execution window. Only admin.
    pub fn update_execution_window(env: Env, caller: Address, new_window: u64) {
        caller.require_auth();
        assert!(caller == Self::admin(env.clone()), "only admin");
        let old_window: u64 = env.storage().instance().get(&DataKey::ExecutionWindow).unwrap_or(1209600);
        env.storage()
            .instance()
            .set(&DataKey::ExecutionWindow, &new_window);
        env.events().publish(
            (symbol_short!("upd_win"),),
            (old_window, new_window),
        );
    }

    fn require_governor(env: &Env, caller: &Address) {
        let governor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Governor)
            .expect("not initialized");
        assert!(caller == &governor, "only governor");
    }

    fn schedule_operation(
        env: Env,
        target: Address,
        data: Bytes,
        fn_name: Symbol,
        delay: u64,
        predecessor: Bytes,
        salt: Bytes,
    ) -> Bytes {
        Self::validate_predecessor(&env, &predecessor);

        let min_delay = Self::min_delay(env.clone());
        assert!(delay >= min_delay, "delay too short");

        let execution_window = Self::execution_window(env.clone());
        let ready_at = env.ledger().timestamp() + delay;
        let expires_at = ready_at + execution_window;
        let op_id = Self::compute_op_id(
            env.clone(),
            target.clone(),
            data.clone(),
            predecessor.clone(),
            salt,
        );

        let op = Operation {
            target,
            data,
            fn_name,
            ready_at,
            expires_at,
            executed: false,
            cancelled: false,
            predecessor,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Operation(op_id.clone()), &op);
        env.events()
            .publish((symbol_short!("schedule"),), op_id.clone());

        op_id
    }

    fn validate_predecessor(env: &Env, predecessor: &Bytes) {
        if predecessor.is_empty() {
            return;
        }

        let op_exists = env
            .storage()
            .persistent()
            .has(&DataKey::Operation(predecessor.clone()));
        let batch_exists = env
            .storage()
            .persistent()
            .has(&DataKey::BatchOperation(predecessor.clone()));

        if !op_exists && !batch_exists {
            env.panic_with_error(TimelockError::PredecessorNotFound);
        }
    }

    fn decode_invocation_args(env: &Env, data: &Bytes) -> Vec<Val> {
        if data.is_empty() {
            return Vec::new(env);
        }

        if let Ok(args) = Vec::<Val>::from_xdr(env, data) {
            return args;
        }

        // Preserve compatibility with legacy callers that used opaque bytes for
        // no-arg calls before structured calldata decoding was implemented.
        Vec::new(env)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        let admin = Address::generate(&env);
        let governor = Address::generate(&env);
        let contract_id = env.register_contract(None, TimelockContract);
        TimelockContractClient::new(&env, &contract_id)
            .initialize(&admin, &governor, &86400, &1209600);
        (env, admin, governor)
    }

    #[test]
    fn test_update_delay_too_short() {
        let (env, admin, _) = setup();
        let contract_id = env.register_contract(None, TimelockContract);
        TimelockContractClient::new(&env, &contract_id)
            .initialize(&admin, &Address::generate(&env), &86400, &1209600);
        let client = TimelockContractClient::new(&env, &contract_id);

        // Should panic when new delay is below MIN_DELAY (86400)
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_delay(&admin, &0);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_update_delay_accepts_valid() {
        let (env, admin, _) = setup();
        let contract_id = env.register_contract(None, TimelockContract);
        TimelockContractClient::new(&env, &contract_id)
            .initialize(&admin, &Address::generate(&env), &86400, &1209600);
        let client = TimelockContractClient::new(&env, &contract_id);

        client.update_delay(&admin, &172800);

        let stored: u64 = env.storage().instance().get(&DataKey::MinDelay).unwrap();
        assert_eq!(stored, 172800);
    }

    #[test]
    fn test_update_delay_emits_event() {
        let (env, admin, _) = setup();
        let contract_id = env.register_contract(None, TimelockContract);
        TimelockContractClient::new(&env, &contract_id)
            .initialize(&admin, &Address::generate(&env), &86400, &1209600);
        let mut client = TimelockContractClient::new(&env, &contract_id);

        client.update_delay(&admin, &172800);

        let events = env.events().all();
        let found = events.iter().any(|event| {
            event.0 == contract_id && event.1 == symbol_short!("upd_dly")
        });
        assert!(found, "DelayUpdated event not emitted");
    }

    #[test]
    fn test_update_delay_requires_admin_auth() {
        let (env, _, governor) = setup();
        let contract_id = env.register_contract(None, TimelockContract);
        TimelockContractClient::new(&env, &contract_id)
            .initialize(&governor, &Address::generate(&env), &86400, &1209600);
        let client = TimelockContractClient::new(&env, &contract_id);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_delay(&governor, &172800);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_update_execution_window_zero_should_fail() {
        let (env, admin, _) = setup();
        let contract_id = env.register_contract(None, TimelockContract);
        TimelockContractClient::new(&env, &contract_id)
            .initialize(&admin, &Address::generate(&env), &86400, &1209600);
        let client = TimelockContractClient::new(&env, &contract_id);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_execution_window(&admin, &0);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_update_execution_window_emits_event() {
        let (env, admin, _) = setup();
        let contract_id = env.register_contract(None, TimelockContract);
        TimelockContractClient::new(&env, &contract_id)
            .initialize(&admin, &Address::generate(&env), &86400, &1209600);
        let mut client = TimelockContractClient::new(&env, &contract_id);

        client.update_execution_window(&admin, &604800);

        let events = env.events().all();
        let found = events.iter().any(|event| {
            event.0 == contract_id && event.1 == symbol_short!("upd_win")
        });
        assert!(found, "ExecutionWindowUpdated event not emitted");
    }

    #[test]
    fn test_update_execution_window_requires_admin_auth() {
        let (env, _, governor) = setup();
        let contract_id = env.register_contract(None, TimelockContract);
        TimelockContractClient::new(&env, &contract_id)
            .initialize(&governor, &Address::generate(&env), &86400, &1209600);
        let client = TimelockContractClient::new(&env, &contract_id);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_execution_window(&governor, &604800);
        }));
        assert!(result.is_err());
    }
}
