use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Events, Ledger as _},
    Address, Bytes, Env, IntoVal, Symbol, TryIntoVal, Val, Vec,
};

/// Mock target contract for testing execution.
#[contract]
pub struct MockTarget;

#[contractimpl]
impl MockTarget {
    pub fn exec(env: Env) {
        env.storage()
            .persistent()
            .set(&symbol_short!("executed"), &true);
    }

    pub fn was_executed(env: Env) -> bool {
        env.storage()
            .persistent()
            .get(&symbol_short!("executed"))
            .unwrap_or(false)
    }

    pub fn store_i128(env: Env, value: i128) {
        env.storage()
            .persistent()
            .set(&symbol_short!("value"), &value);
    }

    pub fn stored_value(env: Env) -> i128 {
        env.storage()
            .persistent()
            .get(&symbol_short!("value"))
            .unwrap_or(0)
    }
}

#[test]
/// schedule_batch now returns a single batch_op_id and emits schbatch.
fn test_schedule_batch_returns_single_id_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &1, &1_209_600);

    let mut targets = Vec::new(&env);
    targets.push_back(Address::generate(&env));
    targets.push_back(Address::generate(&env));

    let mut payloads = Vec::new(&env);
    payloads.push_back(Bytes::from_array(&env, &[1u8, 2u8]));
    payloads.push_back(Bytes::from_array(&env, &[3u8, 4u8]));

    let mut fn_names = Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "ping"));
    fn_names.push_back(Symbol::new(&env, "pong"));

    let batch_op_id = client.schedule_batch(
        &governor,
        &targets,
        &payloads,
        &fn_names,
        &10,
        &Bytes::new(&env),
        &Bytes::from_array(&env, &[9u8]),
    );

    // Returns a single Bytes id (32-byte SHA-256)
    assert_eq!(batch_op_id.len(), 32);

    let events = env.events().all();
    let has_batch_event = events.iter().any(|(_, topics, _)| {
        !topics.is_empty() && {
            let first: Result<Symbol, _> = topics.get(0).unwrap().try_into_val(&env);
            first.is_ok() && first.unwrap() == symbol_short!("schbatch")
        }
    });
    assert!(has_batch_event, "schedule_batch event not emitted");
}

#[test]
/// schedule_batch with same inputs always produces the same batch_op_id.
fn test_batch_op_id_is_deterministic() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = Address::generate(&env);
    let mut targets = Vec::new(&env);
    targets.push_back(target.clone());

    let mut datas = Vec::new(&env);
    datas.push_back(Bytes::new(&env));

    let mut fn_names = Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "exec"));

    let salt = Bytes::from_slice(&env, b"mysalt");

    let id1 = client.schedule_batch(
        &governor,
        &targets,
        &datas,
        &fn_names,
        &0,
        &Bytes::new(&env),
        &salt,
    );
    // Same call again — same id
    let id2 = client.schedule_batch(
        &governor,
        &targets,
        &datas,
        &fn_names,
        &0,
        &Bytes::new(&env),
        &salt,
    );
    assert_eq!(id1, id2);

    // Different salt → different id
    let salt2 = Bytes::from_slice(&env, b"othersalt");
    let id3 = client.schedule_batch(
        &governor,
        &targets,
        &datas,
        &fn_names,
        &0,
        &Bytes::new(&env),
        &salt2,
    );
    assert_ne!(id1, id3);
}

#[test]
/// execute_batch runs all sub-calls atomically and marks the batch as done.
fn test_execute_batch_atomic() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target1 = env.register(MockTarget, ());
    let target2 = env.register(MockTarget, ());

    let mut targets = Vec::new(&env);
    targets.push_back(target1.clone());
    targets.push_back(target2.clone());

    let mut datas = Vec::new(&env);
    datas.push_back(Bytes::new(&env));
    datas.push_back(Bytes::new(&env));

    let mut fn_names = Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "exec"));
    fn_names.push_back(Symbol::new(&env, "exec"));

    let batch_op_id = client.schedule_batch(
        &governor,
        &targets,
        &datas,
        &fn_names,
        &0,
        &Bytes::new(&env),
        &Bytes::from_slice(&env, b"salt"),
    );

    // Not done yet
    assert!(!client.is_batch_done(&batch_op_id));

    // Advance past ready_at
    env.ledger().with_mut(|l| l.timestamp = 1);
    client.execute_batch(&governor, &batch_op_id);

    // Both targets executed
    let t1_done = env.as_contract(&target1, || MockTarget::was_executed(env.clone()));
    let t2_done = env.as_contract(&target2, || MockTarget::was_executed(env.clone()));
    assert!(t1_done, "target1 not executed");
    assert!(t2_done, "target2 not executed");

    // Batch is now done
    assert!(client.is_batch_done(&batch_op_id));

    // Double-execution should fail
    let result = client.try_execute_batch(&governor, &batch_op_id);
    assert!(result.is_err(), "second execute_batch should fail");
}

#[test]
/// cancel() accepts a batch_op_id and prevents execute_batch from running.
fn test_cancel_batch() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());
    let mut targets = Vec::new(&env);
    targets.push_back(target);

    let mut datas = Vec::new(&env);
    datas.push_back(Bytes::new(&env));

    let mut fn_names = Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "exec"));

    let batch_op_id = client.schedule_batch(
        &governor,
        &targets,
        &datas,
        &fn_names,
        &0,
        &Bytes::new(&env),
        &Bytes::from_slice(&env, b"salt"),
    );

    // Cancel the batch
    client.cancel(&admin, &batch_op_id);

    // execute_batch should now fail
    env.ledger().with_mut(|l| l.timestamp = 1);
    let result = client.try_execute_batch(&governor, &batch_op_id);
    assert!(result.is_err(), "execute_batch should fail after cancel");
}

#[test]
/// A batch can use a single op as its predecessor; execute_batch blocks until predecessor is done.
fn test_batch_predecessor_enforcement() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());

    // Schedule single predecessor op
    let pred_op_id = client.schedule(
        &governor,
        &target,
        &Bytes::new(&env),
        &Symbol::new(&env, "exec"),
        &0,
        &Bytes::new(&env),
        &Bytes::from_slice(&env, b"pred_salt"),
    );

    // Schedule batch with pred_op_id as predecessor
    let mut targets = Vec::new(&env);
    targets.push_back(target.clone());

    let mut datas = Vec::new(&env);
    datas.push_back(Bytes::new(&env));

    let mut fn_names = Vec::new(&env);
    fn_names.push_back(Symbol::new(&env, "exec"));

    let batch_id = client.schedule_batch(
        &governor,
        &targets,
        &datas,
        &fn_names,
        &0,
        &pred_op_id,
        &Bytes::from_slice(&env, b"batch_salt"),
    );

    env.ledger().with_mut(|l| l.timestamp = 1);

    // execute_batch fails — predecessor not done
    let result = client.try_execute_batch(&governor, &batch_id);
    assert!(result.is_err(), "should block on predecessor");

    // Execute predecessor
    client.execute(&governor, &pred_op_id);
    assert!(client.is_done(&pred_op_id));

    // Now batch executes successfully
    client.execute_batch(&governor, &batch_id);
    assert!(client.is_batch_done(&batch_id));
}

#[test]
/// Test that operation ID generation includes all components.
fn test_compute_op_id() {
    let env = Env::default();
    let target = Address::generate(&env);
    let data = Bytes::from_slice(&env, b"test data");
    let predecessor = Bytes::from_slice(&env, b"pred");
    let salt = Bytes::from_slice(&env, b"salt");

    let op_id1 = TimelockContract::compute_op_id(
        env.clone(),
        target.clone(),
        data.clone(),
        Bytes::new(&env),
        Bytes::new(&env),
    );
    let op_id2 = TimelockContract::compute_op_id(
        env.clone(),
        target.clone(),
        data.clone(),
        predecessor.clone(),
        salt.clone(),
    );
    let op_id3 = TimelockContract::compute_op_id(
        env.clone(),
        target.clone(),
        data.clone(),
        predecessor.clone(),
        salt.clone(),
    );
    let op_id4 = TimelockContract::compute_op_id(
        env.clone(),
        target.clone(),
        data.clone(),
        Bytes::new(&env),
        salt.clone(),
    );

    // Different predecessor/salt produces different ID
    assert_ne!(op_id1, op_id2);
    // Same inputs produce same ID
    assert_eq!(op_id2, op_id3);
    // Different salt produces different ID
    assert_ne!(op_id2, op_id4);
}

#[test]
/// Test that schedule() stores predecessor and generates correct ID.
fn test_schedule_with_predecessor_and_salt() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = Address::generate(&env);
    let data = Bytes::new(&env);
    let fn_name = Symbol::new(&env, "exec");
    let delay = 1000u64;
    let predecessor = Bytes::new(&env);
    let salt = Bytes::from_slice(&env, b"unique_salt");

    let op_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &predecessor,
        &salt,
    );

    // Verify operation is stored
    let op: Operation = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::Operation(op_id.clone()))
            .unwrap()
    });
    assert_eq!(op.target, target);
    assert_eq!(op.data, data);
    assert_eq!(op.fn_name, fn_name);
    assert_eq!(op.predecessor, predecessor);
    assert!(!op.executed);
    assert!(!op.cancelled);
}

#[test]
/// Test that schedule() validates predecessor exists.
fn test_schedule_validates_predecessor() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = Address::generate(&env);
    let data = Bytes::new(&env);
    let fn_name = Symbol::new(&env, "exec");
    let delay = 1000u64;
    let non_existent_pred = Bytes::from_slice(&env, b"nonexistent");

    // Should panic with "predecessor not found"
    let result = client.try_schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &non_existent_pred,
        &Bytes::new(&env),
    );
    assert!(result.is_err());
}

#[test]
/// Test that is_done() returns correct values.
fn test_is_done() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());
    let data = Bytes::new(&env);
    let fn_name = Symbol::new(&env, "exec");
    let delay = 1000u64;

    // Schedule an operation
    let op_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );

    // Not done yet
    assert!(!client.is_done(&op_id));

    // Execute it
    env.ledger().with_mut(|l| l.timestamp = 1001);
    client.execute(&governor, &op_id);

    // Now done
    assert!(client.is_done(&op_id));

    // Non-existent operation returns false
    let fake_id = Bytes::from_slice(&env, b"fakeopid12345678901234567890");
    assert!(!client.is_done(&fake_id));
}

#[test]
/// Test predecessor enforcement in execute().
fn test_predecessor_enforcement() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600); // 0 delay for speed

    let target = env.register(MockTarget, ());
    let data = Bytes::new(&env);
    let fn_name = Symbol::new(&env, "exec");

    // Schedule operation A
    let op_a_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &0u64,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );

    // Schedule operation B with A as predecessor
    let op_b_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &0u64,
        &op_a_id.clone(),
        &Bytes::new(&env),
    );

    // Execute B should fail with PredecessorNotDone
    let result = client.try_execute(&governor, &op_b_id);
    assert!(result.is_err());

    // Execute A should succeed
    client.execute(&governor, &op_a_id);
    assert!(client.is_done(&op_a_id));

    // Now B should execute successfully
    client.execute(&governor, &op_b_id);
    assert!(client.is_done(&op_b_id));
}

#[test]
/// Test that predecessor blocking works even when both operations are ready.
fn test_predecessor_blocking_when_ready() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());
    let data = Bytes::new(&env);
    let fn_name = Symbol::new(&env, "exec");

    // Schedule A and B with 0 delay (both ready immediately)
    let op_a_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &0u64,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );
    let op_b_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &0u64,
        &op_a_id.clone(),
        &Bytes::new(&env),
    );

    // Advance time to ensure both are ready
    env.ledger().with_mut(|l| l.timestamp = 1);

    // B should still fail because A not done
    let result = client.try_execute(&governor, &op_b_id);
    assert!(result.is_err());

    // Execute A
    client.execute(&governor, &op_a_id);

    // B should now succeed immediately (no additional delay)
    client.execute(&governor, &op_b_id);
}

#[test]
/// Test salt uniqueness: same target/data with different salts produce different IDs.
fn test_salt_uniqueness() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = Address::generate(&env);
    let data = Bytes::from_slice(&env, b"same data");
    let fn_name = Symbol::new(&env, "exec");
    let delay = 1000u64;

    let salt1 = Bytes::from_slice(&env, b"salt1");
    let salt2 = Bytes::from_slice(&env, b"salt2");

    let op_id1 = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &salt1,
    );
    let op_id2 = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &salt2,
    );

    assert_ne!(op_id1, op_id2);

    // Both operations should coexist in storage
    let (op1, op2): (Operation, Operation) = env.as_contract(&contract_id, || {
        (
            env.storage()
                .persistent()
                .get(&DataKey::Operation(op_id1.clone()))
                .unwrap(),
            env.storage()
                .persistent()
                .get(&DataKey::Operation(op_id2.clone()))
                .unwrap(),
        )
    });
    assert_eq!(op1.data, data);
    assert_eq!(op2.data, data);
}

#[test]
/// Test that same salt produces same ID (idempotent scheduling).
fn test_same_salt_same_id() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = Address::generate(&env);
    let data = Bytes::from_slice(&env, b"same data");
    let fn_name = Symbol::new(&env, "exec");
    let delay = 1000u64;
    let salt = Bytes::from_slice(&env, b"same_salt");

    let op_id1 = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &salt,
    );
    let op_id2 = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &salt,
    );

    assert_eq!(op_id1, op_id2);

    // The second schedule should overwrite the first (same storage key)
    let op: Operation = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::Operation(op_id1.clone()))
            .unwrap()
    });
    // Both operations have same ID, so only one record exists
    assert_eq!(op.data, data);
}

#[test]
/// Test that different predecessors produce different IDs even with same salt.
fn test_predecessor_changes_id() {
    let env = Env::default();
    env.mock_all_auths();
    let _contract_id = env.register(TimelockContract, ());

    let target = Address::generate(&env);
    let data = Bytes::from_slice(&env, b"same data");
    let salt = Bytes::from_slice(&env, b"same_salt");
    let pred1 = Bytes::from_slice(&env, b"pred1");
    let pred2 = Bytes::from_slice(&env, b"pred2");

    let op_id1 = TimelockContract::compute_op_id(
        env.clone(),
        target.clone(),
        data.clone(),
        pred1,
        salt.clone(),
    );
    let op_id2 = TimelockContract::compute_op_id(env.clone(), target, data, pred2, salt);

    assert_ne!(op_id1, op_id2);
}

#[test]
/// Test that empty predecessor and empty salt produce consistent ID.
fn test_empty_predecessor_and_salt() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = Address::generate(&env);
    let data = Bytes::from_slice(&env, b"calldata");
    let fn_name = Symbol::new(&env, "exec");
    let delay = 1000u64;

    let op_id1 = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );
    let op_id2 = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );

    assert_eq!(op_id1, op_id2);
}

#[test]
/// Test that operation with no predecessor executes normally.
fn test_no_predecessor_executes() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());
    let data = Bytes::new(&env);
    let fn_name = Symbol::new(&env, "exec");
    let delay = 0u64;

    let op_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );

    // Should execute without predecessor check
    client.execute(&governor, &op_id);
    assert!(client.is_done(&op_id));

    // Verify MockTarget was called
    let mock_client = MockTargetClient::new(&env, &target);
    assert!(mock_client.was_executed());
}

#[test]
/// Test execution deadline functionality.
fn test_execution_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    let execution_window = 1000u64;
    client.initialize(&admin, &governor, &0, &execution_window);

    let target = env.register(MockTarget, ());
    let data = Bytes::new(&env);
    let fn_name = Symbol::new(&env, "exec");
    let delay = 500u64;

    let op_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );

    // Verify expires_at is set correctly
    let op: Operation = env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .get(&DataKey::Operation(op_id.clone()))
            .unwrap()
    });
    assert_eq!(op.ready_at, 500);
    assert_eq!(op.expires_at, 1500); // 500 + 1000

    // Should not be ready before delay
    assert!(!client.is_ready(&op_id));

    // Should be ready after delay but before expiration
    env.ledger().with_mut(|l| l.timestamp = 600);
    assert!(client.is_ready(&op_id));

    // Should execute successfully within window
    client.execute(&governor, &op_id);
    assert!(client.is_done(&op_id));
}

#[test]
fn test_execute_decodes_xdr_args() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    client.initialize(&admin, &governor, &0, &1_209_600);

    let target = env.register(MockTarget, ());
    let mut args: Vec<Val> = Vec::new(&env);
    args.push_back(42i128.into_val(&env));
    let data = args.to_xdr(&env);

    let op_id = client.schedule(
        &governor,
        &target,
        &data,
        &Symbol::new(&env, "store_i128"),
        &0u64,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );

    client.execute(&governor, &op_id);

    let target_client = MockTargetClient::new(&env, &target);
    assert_eq!(target_client.stored_value(), 42);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
/// Test that execution fails after deadline.
fn test_execute_after_deadline_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    let execution_window = 1000u64;
    client.initialize(&admin, &governor, &0, &execution_window);

    let target = env.register(MockTarget, ());
    let data = Bytes::new(&env);
    let fn_name = Symbol::new(&env, "exec");
    let delay = 500u64;

    let op_id = client.schedule(
        &governor,
        &target,
        &data,
        &fn_name,
        &delay,
        &Bytes::new(&env),
        &Bytes::new(&env),
    );

    // Advance past expiration time
    env.ledger().with_mut(|l| l.timestamp = 2000);

    // Should not be ready (expired)
    assert!(!client.is_ready(&op_id));

    // Should panic when trying to execute expired operation
    client.execute(&governor, &op_id);
}

#[test]
/// Test execution_window getter and setter.
fn test_execution_window_config() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    let execution_window = 5000u64;

    client.initialize(&admin, &governor, &100, &execution_window);

    // Check getter returns correct value
    assert_eq!(client.execution_window(), execution_window);

    // Update execution window
    let new_window = 10000u64;
    client.update_execution_window(&admin, &new_window);

    // Check updated value
    assert_eq!(client.execution_window(), new_window);
}

#[test]
#[should_panic(expected = "only admin")]
/// Test that only admin can update execution window.
fn test_update_execution_window_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    let unauthorized = Address::generate(&env);

    client.initialize(&admin, &governor, &100, &1000);

    // Should panic when unauthorized user tries to update
    client.update_execution_window(&unauthorized, &2000);
}

#[test]
#[should_panic(expected = "already initialized")]
/// Test that initialize() cannot be called twice.
fn test_initialize_guard_prevents_reinitialization() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(TimelockContract, ());
    let client = TimelockContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let governor = Address::generate(&env);
    let attacker = Address::generate(&env);

    client.initialize(&admin, &governor, &100, &1000);

    // Second initialize attempt should panic
    client.initialize(&attacker, &attacker, &0, &u64::MAX);
}
