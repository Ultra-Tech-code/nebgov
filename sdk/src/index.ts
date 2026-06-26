/**
 * @nebgov/sdk — TypeScript SDK for the NebGov governance framework on Stellar.
 *
 * @example
 * import { GovernorClient, VotesClient, ProposalState, VoteSupport } from "@nebgov/sdk";
 *
 * const client = new GovernorClient({
 *   governorAddress: "CABC...",
 *   timelockAddress: "CDEF...",
 *   votesAddress: "CGHI...",
 *   network: "testnet",
 * });
 */

export { GovernorClient, hashDescription, uploadProposalMetadata } from "./governor";
export { VotesClient } from "./votes";
export type { TopDelegatesOptions, TopDelegatesResult } from "./votes";
export { FactoryClient } from "./factory";
export type { GovernorEntry, DeploySettings } from "./factory";
export { TimelockClient } from "./timelock";
export { TreasuryClient } from "./treasury";
export { WrapperClient } from "./wrapper";
export type { WrapperConfig } from "./wrapper";
export {
  GovernorError,
  GovernorErrorCode,
  TimelockError,
  TimelockErrorCode,
  VotesError,
  VotesErrorCode,
  TreasuryError,
  TreasuryErrorCode,
  parseGovernorError,
  parseTimelockError,
  parseVotesError,
  parseTreasuryError,
  extractContractErrorCode,
} from "./errors";
export type { SorobanRpcError } from "./errors";
export {
  subscribeToProposals,
  subscribeToVotes,
  getProposalEvents,
  subscribeToProposalQueued,
  subscribeToProposalExecuted,
  subscribeToProposalCancelled,
  subscribeToProposalExpired,
  subscribeToGovernorUpgraded,
  subscribeToConfigUpdated,
  subscribeToPauseEvents,
  subscribeToUnpauseEvents,
} from "./events";
export type {
  SorobanEvent,
  SubscriptionOptions,
  ProposalCreatedEventData,
  ProposalVetoedEventData,
  VoteCastEventData,
  ProposalQueuedEventData,
  ProposalExecutedEventData,
  ProposalCancelledEventData,
  ProposalExpiredEventData,
  GovernorUpgradedEventData,
  ConfigUpdatedEventData,
  PauseEventData,
  UnpauseEventData,
} from "./events";
export {
  parseProposalCreatedEvent,
  parseVoteCastEvent,
  parseProposalQueuedEvent,
  parseProposalVetoedEvent,
  parseProposalExecutedEvent,
  parseProposalCancelledEvent,
  parseProposalExpiredEvent,
  parseGovernorUpgradedEvent,
  parseConfigUpdatedEvent,
  parsePauseEvent,
  parseUnpauseEvent,
} from "./events";
export * from "./types";
export { computeQuadraticWeight, hexToBytes32 } from "./utils";
export { streamEvents } from "./streamEvents";
export type { IndexerEvent, WsEventType, StreamEventsOptions, UnsubscribeFn } from "./streamEvents";
