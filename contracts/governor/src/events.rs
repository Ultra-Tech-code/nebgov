use soroban_sdk::{Address, Bytes, BytesN, Env, String, Symbol, Vec};

use crate::{GovernorSettings, Proposal, VoteSupport};

pub const PROPOSAL_CREATED_TOPIC: &str = "ProposalCreated";
pub const PAUSED_TOPIC: &str = "Paused";
pub const UNPAUSED_TOPIC: &str = "Unpaused";
pub const VOTE_CAST_TOPIC: &str = "VoteCast";
pub const VOTE_CAST_WITH_REASON_TOPIC: &str = "VoteCastWithReason";
pub const PROPOSAL_QUEUED_TOPIC: &str = "ProposalQueued";
pub const PROPOSAL_EXECUTED_TOPIC: &str = "ProposalExecuted";
pub const PROPOSAL_CANCELLED_TOPIC: &str = "ProposalCancelled";
pub const PROPOSAL_EXPIRED_TOPIC: &str = "ProposalExpired";
pub const GOVERNOR_UPGRADED_TOPIC: &str = "GovernorUpgraded";
pub const CONFIG_UPDATED_TOPIC: &str = "ConfigUpdated";

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct ProposalCreatedEvent {
    pub proposal_id: u64,
    pub proposer: Address,
    pub description: String,
    pub description_hash: BytesN<32>,
    pub metadata_uri: String,
    pub targets: Vec<Address>,
    pub fn_names: Vec<Symbol>,
    pub calldatas: Vec<Bytes>,
    pub start_ledger: u32,
    pub end_ledger: u32,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct VoteCastEvent {
    pub proposal_id: u64,
    pub voter: Address,
    pub support: u32,
    pub weight: i128,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct VoteCastWithReasonEvent {
    pub proposal_id: u64,
    pub voter: Address,
    pub support: u32,
    pub weight: i128,
    pub reason: String,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct ProposalQueuedEvent {
    pub proposal_id: u64,
    pub op_id: Bytes,
    pub eta: u64,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct ProposalExecutedEvent {
    pub proposal_id: u64,
    pub caller: Address,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct ProposalCancelledEvent {
    pub proposal_id: u64,
    pub caller: Address,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct ProposalExpiredEvent {
    pub proposal_id: u64,
    pub expired_at_ledger: u32,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct GovernorUpgradedEvent {
    pub old_hash: BytesN<32>,
    pub new_hash: BytesN<32>,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct ConfigUpdatedEvent {
    pub old_settings: GovernorSettings,
    pub new_settings: GovernorSettings,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct PauseEvent {
    pub pauser: Address,
    pub ledger: u32,
}

#[derive(Clone)]
#[soroban_sdk::contracttype]
pub struct UnpauseEvent {
    pub ledger: u32,
}

fn vote_support_to_u32(support: &VoteSupport) -> u32 {
    match support {
        VoteSupport::Against => 0,
        VoteSupport::For => 1,
        VoteSupport::Abstain => 2,
    }
}

pub fn emit_proposal_created(env: &Env, proposal: &Proposal) {
    env.events().publish(
        (
            Symbol::new(env, PROPOSAL_CREATED_TOPIC),
            proposal.proposer.clone(),
        ),
        ProposalCreatedEvent {
            proposal_id: proposal.id,
            proposer: proposal.proposer.clone(),
            description: proposal.description.clone(),
            description_hash: proposal.description_hash.clone(),
            metadata_uri: proposal.metadata_uri.clone(),
            targets: proposal.targets.clone(),
            fn_names: proposal.fn_names.clone(),
            calldatas: proposal.calldatas.clone(),
            start_ledger: proposal.start_ledger,
            end_ledger: proposal.end_ledger,
        },
    );
}

pub fn emit_vote_cast(
    env: &Env,
    voter: &Address,
    proposal_id: u64,
    support: &VoteSupport,
    weight: i128,
) {
    env.events().publish(
        (Symbol::new(env, VOTE_CAST_TOPIC), voter.clone()),
        VoteCastEvent {
            proposal_id,
            voter: voter.clone(),
            support: vote_support_to_u32(support),
            weight,
        },
    );
}

pub fn emit_vote_cast_with_reason(
    env: &Env,
    voter: &Address,
    proposal_id: u64,
    support: &VoteSupport,
    weight: i128,
    reason: String,
) {
    env.events().publish(
        (
            Symbol::new(env, VOTE_CAST_WITH_REASON_TOPIC),
            proposal_id,
            voter.clone(),
        ),
        (vote_support_to_u32(support), weight, reason),
    );
}

pub fn emit_proposal_queued(env: &Env, proposal_id: u64, op_id: &Bytes, eta: u64) {
    env.events().publish(
        (Symbol::new(env, PROPOSAL_QUEUED_TOPIC), proposal_id),
        (op_id.clone(), eta),
    );
}

pub fn emit_proposal_executed(env: &Env, proposal_id: u64, caller: &Address) {
    env.events().publish(
        (Symbol::new(env, PROPOSAL_EXECUTED_TOPIC), proposal_id),
        (caller.clone(),),
    );
}

pub fn emit_proposal_cancelled(env: &Env, proposal_id: u64, caller: &Address) {
    env.events().publish(
        (Symbol::new(env, PROPOSAL_CANCELLED_TOPIC), proposal_id),
        (caller.clone(),),
    );
}

pub fn emit_proposal_expired(env: &Env, proposal_id: u64, expired_at_ledger: u32) {
    env.events().publish(
        (Symbol::new(env, PROPOSAL_EXPIRED_TOPIC),),
        ProposalExpiredEvent {
            proposal_id,
            expired_at_ledger,
        },
    );
}

pub fn emit_governor_upgraded(env: &Env, old_hash: &BytesN<32>, new_hash: &BytesN<32>) {
    env.events().publish(
        (Symbol::new(env, GOVERNOR_UPGRADED_TOPIC),),
        GovernorUpgradedEvent {
            old_hash: old_hash.clone(),
            new_hash: new_hash.clone(),
        },
    );
}

pub fn emit_config_updated(
    env: &Env,
    old_settings: &GovernorSettings,
    new_settings: &GovernorSettings,
) {
    env.events().publish(
        (Symbol::new(env, CONFIG_UPDATED_TOPIC),),
        ConfigUpdatedEvent {
            old_settings: old_settings.clone(),
            new_settings: new_settings.clone(),
        },
    );
}

pub fn emit_paused(env: &Env, pauser: &Address) {
    env.events().publish(
        (Symbol::new(env, PAUSED_TOPIC), pauser.clone()),
        PauseEvent {
            pauser: pauser.clone(),
            ledger: env.ledger().sequence(),
        },
    );
}

pub fn emit_unpaused(env: &Env) {
    env.events().publish(
        (Symbol::new(env, UNPAUSED_TOPIC),),
        UnpauseEvent {
            ledger: env.ledger().sequence(),
        },
    );
}
