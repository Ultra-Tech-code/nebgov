import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  GovernorConfig,
  ExecutionGasEstimate,
  GovernorSettings,
  GovernorSettingsValidationLimits,
  Proposal,
  ProposalAction,
  ProposalInput,
  ProposalSimulationResult,
  ProposalState,
  ProposalVotes,
  VoteSupport,
  VoteType,
  Network,
  UnknownProposalStateError,
  TimelockInfo,
  CanProposeResult,
  VotingHistoryEntry,
} from "./types";

import { TimelockClient } from "./timelock";

/** Options for uploading proposal metadata to IPFS. */
export interface MetadataUploadOptions {
  /** Pinata API Key (JWT or API Key) */
  pinataApiKey?: string;
  /** Pinata Secret Key (if using API Key/Secret pair) */
  pinataSecretKey?: string;
  /**
   * Custom uploader function for other IPFS gateways.
   *
   * Use this to integrate any storage provider not natively supported by the
   * SDK (e.g. web3.storage, nft.storage, Filebase, etc.).  The function
   * receives the raw description string and must return a fully-qualified
   * IPFS URI (`ipfs://…`).
   *
   * @example
   * // web3.storage integration (tracked in issue #429)
   * const options: MetadataUploadOptions = {
   *   customUploader: async (content) => {
   *     // Use @web3-storage/w3up-client or any compatible library here.
   *     throw new Error("web3.storage uploader not yet configured");
   *   },
   * };
   */
  customUploader?: (content: string) => Promise<string>;
}

import { GovernorError, GovernorErrorCode } from "./errors";
import { hexToBytes32, withRetry } from "./utils";

const RPC_URLS: Record<Network, string> = {
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

const DEFAULT_MAX_VOTING_DELAY = 1_209_600;
const DEFAULT_MIN_VOTING_PERIOD = 1;

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  return 0n;
}

function simulationCostValue(
  cost: unknown,
  ...keys: string[]
): bigint | undefined {
  if (!cost || typeof cost !== "object") return undefined;
  const record = cost as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return toBigInt(value);
  }
  return undefined;
}

function scVecAddress(addrs: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    addrs.map((a) => nativeToScVal(a, { type: "address" })),
  );
}

function scVecSymbol(syms: string[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    syms.map((s) => nativeToScVal(s.trim(), { type: "symbol" })),
  );
}

function scVecBytes(blobs: (Buffer | Uint8Array)[]): xdr.ScVal {
  return xdr.ScVal.scvVec(
    blobs.map((b) => nativeToScVal(b, { type: "bytes" })),
  );
}

/**
 * GovernorClient — interact with a deployed NebGov governor contract.
 *
 * TODO issue #14: add full error handling, retry logic, and simulation flow.
 */
export class GovernorClient {
  private readonly config: GovernorConfig;
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(config: GovernorConfig) {
    this.config = config;
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.governorAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  private async retry<T>(
    fn: () => Promise<T>,
    retryOn?: (e: unknown) => boolean,
  ): Promise<T> {
    return withRetry(fn, {
      maxAttempts: this.config.maxAttempts ?? 3,
      baseDelayMs: this.config.baseDelayMs ?? 1000,
      retryOn,
      onRetry: (attempt, error) => {
        console.debug(`[GovernorClient] Retry attempt ${attempt} due to error:`, error);
      },
    });
  }

  private isNetworkError(e: unknown): boolean {
    if (e instanceof Error) {
      const msg = e.message.toLowerCase();
      if (
        msg.includes("fetch") ||
        msg.includes("network") ||
        msg.includes("timeout") ||
        msg.includes("aborted") ||
        msg.includes("connection refused") ||
        msg.includes("econnrefused") ||
        msg.includes("500") ||
        msg.includes("502") ||
        msg.includes("503") ||
        msg.includes("504")
      ) {
        return true;
      }
    }
    return false;
  }

  private isRetryableSubmissionError(e: unknown): boolean {
    if (this.isNetworkError(e)) return true;

    // Do not retry on contract errors (parsed as GovernorError with code < 100)
    if (e instanceof GovernorError && e.code < 100) {
      return false;
    }

    // Do not retry if already in mempool (idempotency check)
    if (e instanceof Error && e.message.includes("TransactionAlreadyInMempool")) {
      return false;
    }

    return false;
  }

  /**
   * Create a new governance proposal (multi-action, matching on-chain `propose`).
   *
   * @param signer The account proposing the change
   * @param description A brief summary of the proposal
   * @param descriptionHash SHA-256 hash of the full description (hex string)
   * @param metadataUri URI pointing to the full description (ipfs:// or https://)
   * @param targets Calldata targets (same length as `fnNames` / `calldatas`)
   * @param fnNames Function names on each target
   * @param calldatas Encoded arguments for each call
   * @returns The unique identifier of the created proposal
   */
  async propose(
    signer: Keypair,
    description: string,
    descriptionHashOrTargets: string | string[],
    metadataUriOrFnNames: string | string[],
    targetsOrCalldatas: string[] | (Buffer | Uint8Array)[],
    fnNamesArg?: string[],
    calldatasArg?: (Buffer | Uint8Array)[],
  ): Promise<bigint> {
    return this.retry(async () => {
      const legacyCall = Array.isArray(descriptionHashOrTargets);
      const descriptionHash = legacyCall
        ? "0".repeat(64)
        : descriptionHashOrTargets;
      const metadataUri = legacyCall ? "" : (metadataUriOrFnNames as string);
      const targets = legacyCall
        ? descriptionHashOrTargets
        : (targetsOrCalldatas as string[]);
      const fnNames = legacyCall ? (metadataUriOrFnNames as string[]) : fnNamesArg;
      const calldatas = legacyCall
        ? (targetsOrCalldatas as (Buffer | Uint8Array)[])
        : calldatasArg;

      if (!fnNames || !calldatas) {
        throw new GovernorError(
          GovernorErrorCode.InvalidArguments,
          "targets, fnNames, and calldatas are required",
        );
      }
      if (
        targets.length !== fnNames.length ||
        targets.length !== calldatas.length
      ) {
        throw new GovernorError(
          GovernorErrorCode.InvalidArguments,
          "targets, fnNames, and calldatas must have the same length",
        );
      }
      if (targets.length === 0) {
        throw new GovernorError(
          GovernorErrorCode.InvalidArguments,
          "At least one on-chain action is required",
        );
      }

      // Convert hex string to BytesN<32>
      const hashBytes = hexToBytes32(descriptionHash);

      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "propose",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(description, { type: "string" }),
            nativeToScVal(hashBytes, { type: "bytes" }),
            nativeToScVal(metadataUri, { type: "string" }),
            scVecAddress(targets),
            scVecSymbol(fnNames),
            scVecBytes(calldatas),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);

      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw new Error(`Transaction failed: ${JSON.stringify(result)}`);
      }

      const confirmed = await this.pollForConfirmation(result.hash);
      const returnVal = confirmed.returnValue;
      return returnVal ? BigInt(scValToNative(returnVal)) : 0n;
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Same as {@link propose} but signs with a wallet callback (unsigned XDR in → signed XDR out).
   *
   * @returns An object containing the new `proposalId` and the Stellar `txHash`,
   *   both suitable for UI display and block-explorer linking.
   */
  async proposeWithSign(
    signerPublicKey: string,
    description: string,
    descriptionHash: string,
    metadataUri: string,
    targets: string[],
    fnNames: string[],
    calldatas: (Buffer | Uint8Array)[],
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<{ proposalId: bigint; txHash: string }> {
    if (
      targets.length !== fnNames.length ||
      targets.length !== calldatas.length
    ) {
      throw new Error(
        "targets, fnNames, and calldatas must have the same length",
      );
    }
    if (targets.length === 0) {
      throw new Error("At least one on-chain action is required");
    }

    const hashBytes = hexToBytes32(descriptionHash);

    const account = await this.server.getAccount(signerPublicKey);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "propose",
          nativeToScVal(signerPublicKey, { type: "address" }),
          nativeToScVal(description, { type: "string" }),
          nativeToScVal(hashBytes, { type: "bytes" }),
          nativeToScVal(metadataUri, { type: "string" }),
          scVecAddress(targets),
          scVecSymbol(fnNames),
          scVecBytes(calldatas),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await signUnsignedXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(
      signedXdr,
      this.networkPassphrase,
    );
    const result = await this.server.sendTransaction(signed);
    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(result)}`);
    }
    const confirmed = await this.pollForConfirmation(result.hash);
    const returnVal = confirmed.returnValue;
    const proposalId = returnVal ? BigInt(scValToNative(returnVal)) : 0n;
    return { proposalId, txHash: result.hash };
  }

  /** Minimum voting power required to create a proposal (`proposal_threshold`). */
  async proposalThreshold(): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(this.contract.call("proposal_threshold"))
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return 0n;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? BigInt(scValToNative(raw) as number | bigint | string) : 0n;
    });
  }

  /** Read the full governor settings struct via `get_settings()`. */
  async getSettings(
    sourceAccount?: string,
  ): Promise<GovernorSettings> {
    return this.retry(async () => {
      const readAccount = this.readAccount(sourceAccount);
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(await this.server.getAccount(readAccount), {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(this.contract.call("get_settings"))
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        throw new Error(`Simulation error: ${result.error}`);
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) throw new Error("No settings return value");

      const native = scValToNative(raw) as Record<string, unknown>;
      const voteTypeRaw = native.vote_type;
      const voteTypeValue = Array.isArray(voteTypeRaw)
        ? String(voteTypeRaw[0] ?? "")
        : String(voteTypeRaw ?? "");
      const voteType =
        voteTypeValue === VoteType.Simple ||
        voteTypeValue === VoteType.Quadratic
          ? (voteTypeValue as VoteType)
          : VoteType.Extended;

      return {
        votingDelay: Number(native.voting_delay ?? 0),
        votingPeriod: Number(native.voting_period ?? 0),
        quorumNumerator: Number(native.quorum_numerator ?? 0),
        proposalThreshold: toBigInt(native.proposal_threshold),
        guardian: String(native.guardian ?? ""),
        voteType,
        proposalGracePeriod: Number(native.proposal_grace_period ?? 0),
        useDynamicQuorum: Boolean(native.use_dynamic_quorum ?? false),
        reflectorOracle: native.reflector_oracle
          ? String(native.reflector_oracle)
          : null,
        minQuorumUsd: toBigInt(native.min_quorum_usd),
        maxCalldataSize: Number(native.max_calldata_size ?? 10_000),
        proposalCooldown: Number(native.proposal_cooldown ?? 100),
        maxProposalsPerPeriod: Number(native.max_proposals_per_period ?? 5),
        proposalPeriodDuration: Number(native.proposal_period_duration ?? 10_000),
      };
    });
  }

  /**
   * Simulate a single contract invocation (for validating calldata before proposing).
   */
  async simulateTargetInvocation(
    footprintSourceAccount: string,
    contractId: string,
    functionName: string,
    args: xdr.ScVal[],
  ): Promise<{
    ok: boolean;
    error?: string;
    cpuInsns?: string;
    memBytes?: string;
  }> {
    return this.retry(async () => {
      const target = new Contract(contractId);
      const op = target.call(functionName, ...args);
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(footprintSourceAccount),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(op)
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        const err = result as unknown as { error?: string };
        return { ok: false, error: err.error ?? "Simulation failed" };
      }
      const ok = result as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
        cost?: { cpuInsns?: string; memBytes?: string };
      };
      return {
        ok: true,
        cpuInsns: ok.cost?.cpuInsns,
        memBytes: ok.cost?.memBytes,
      };
    });
  }

  /**
   * Simulate each action in a proposal and aggregate compute hints.
   */
  async simulateProposal(
    actions: ProposalAction[],
    sourceAccount?: string,
  ): Promise<ProposalSimulationResult> {
    return this.retry(async () => {
      try {
        let computeUnits = 0;
        const stateChanges: unknown[] = [];

        for (const action of actions) {
          const target = new Contract(action.target);
          const op = target.call(
            action.function,
            ...action.args.map((arg) => nativeToScVal(arg)),
          );
          const readAccount = this.readAccount(sourceAccount);
      const result = await this.server.simulateTransaction(
            new TransactionBuilder(
              await this.server.getAccount(readAccount),
              { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
            )
              .addOperation(op)
              .setTimeout(30)
              .build(),
          );

          if (SorobanRpc.Api.isSimulationError(result)) {
            const err = result as unknown as { error?: string };
            return {
              success: false,
              error: `Simulation failed: ${err.error ?? "unknown"}`,
            };
          }

          const success = result as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
            result?: { cost?: { cpuInstructions?: number } } | null;
            cost?: { cpuInstructions?: number; cpuInsns?: string };
          };
          if (!success.result) {
            return { success: false, error: "No simulation result returned" };
          }

          const cost =
            success.result.cost?.cpuInstructions ??
            success.cost?.cpuInstructions ??
            Number(success.cost?.cpuInsns ?? 0);
          computeUnits += Number(cost ?? 0);
        }

        return { success: true, computeUnits, stateChanges };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Simulation failed",
        };
      }
    });
  }

  /** Resource hints for the full `propose` transaction (simulation only). */
  async estimateProposeResources(
    proposer: string,
    description: string,
    descriptionHash: string,
    metadataUri: string,
    targets: string[],
    fnNames: string[],
    calldatas: (Buffer | Uint8Array)[],
  ): Promise<{
    ok: boolean;
    error?: string;
    cpuInsns?: string;
    memBytes?: string;
  }> {
    return this.retry(async () => {
      try {
        const hashBytes = hexToBytes32(descriptionHash);
        const account = await this.server.getAccount(proposer);
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(
            this.contract.call(
              "propose",
              nativeToScVal(proposer, { type: "address" }),
              nativeToScVal(description, { type: "string" }),
              nativeToScVal(hashBytes, { type: "bytes" }),
              nativeToScVal(metadataUri, { type: "string" }),
              scVecAddress(targets),
              scVecSymbol(fnNames),
              scVecBytes(calldatas),
            ),
          )
          .setTimeout(30)
          .build();

        const result = await this.server.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(result)) {
          const err = result as unknown as { error?: string };
          return { ok: false, error: err.error ?? "Simulation failed" };
        }
        const ok = result as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
          cost?: { cpuInsns?: string; memBytes?: string };
        };
        return {
          ok: true,
          cpuInsns: ok.cost?.cpuInsns,
          memBytes: ok.cost?.memBytes,
        };
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "estimate failed",
        };
      }
    });
  }

  /**
   * Simulate the governor's `estimate_execution_gas` view and return its cost hint.
   *
   * `sourceAccount` should be any funded account on the selected network. If it
   * is omitted, the client falls back to the configured governor address for
   * compatibility with existing SDK read methods.
   */
  async estimateExecutionGas(
    proposalId: bigint,
    sourceAccount?: string,
  ): Promise<ExecutionGasEstimate> {
    return this.retry(async () => {
      const account = await this.server.getAccount(this.readAccount(sourceAccount));
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "estimate_execution_gas",
            nativeToScVal(proposalId, { type: "u64" }),
          ),
        )
        .setTimeout(30)
        .build();

      const result = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(result)) {
        throw new Error(`Simulation error: ${result.error}`);
      }

      const success = result as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
        cost?: Record<string, unknown>;
      };
      const raw = success.result?.retval;
      if (!raw) throw new Error("No return value");

      const native = scValToNative(raw) as Record<string, unknown>;
      return {
        proposalId: toBigInt(native.proposal_id ?? native.proposalId),
        actionCount: Number(native.action_count ?? native.actionCount ?? 0),
        calldataBytes: Number(native.calldata_bytes ?? native.calldataBytes ?? 0),
        estimatedCpuInsns: toBigInt(
          native.estimated_cpu_insns ?? native.estimatedCpuInsns,
        ),
        estimatedMemBytes: toBigInt(
          native.estimated_mem_bytes ?? native.estimatedMemBytes,
        ),
        estimatedFeeStroops: toBigInt(
          native.estimated_fee_stroops ?? native.estimatedFeeStroops,
        ),
        rpcCpuInsns: simulationCostValue(
          success.cost,
          "cpuInsns",
          "cpuInstructions",
        ),
        rpcMemBytes: simulationCostValue(success.cost, "memBytes", "memoryBytes"),
      };
    });
  }

  /**
   * Simulate `cast_vote` and return the estimated resource cost without submitting.
   */
  async estimateVoteGas(
    voter: string,
    proposalId: bigint,
    support: VoteSupport,
  ): Promise<{
    ok: boolean;
    error?: string;
    cpuInsns?: string;
    memBytes?: string;
    estimatedFeeStroops?: string;
  }> {
    return this.retry(async () => {
      try {
        const account = await this.server.getAccount(voter);
        const supportScVal = xdr.ScVal.scvVec([
          xdr.ScVal.scvSymbol(VoteSupport[support]),
        ]);

        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(
            this.contract.call(
              "cast_vote",
              nativeToScVal(voter, { type: "address" }),
              nativeToScVal(proposalId, { type: "u64" }),
              supportScVal,
            ),
          )
          .setTimeout(30)
          .build();

        const result = await this.server.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(result)) {
          const err = result as unknown as { error?: string };
          return { ok: false, error: err.error ?? "Simulation failed" };
        }

        const success = result as SorobanRpc.Api.SimulateTransactionSuccessResponse & {
          cost?: { cpuInsns?: string; memBytes?: string; cpuInstructions?: number; memoryBytes?: number };
          minResourceFee?: unknown;
          min_resource_fee?: unknown;
        };

        return {
          ok: true,
          cpuInsns:
            success.cost?.cpuInsns ??
            success.cost?.cpuInstructions?.toString(),
          memBytes:
            success.cost?.memBytes ??
            success.cost?.memoryBytes?.toString(),
          estimatedFeeStroops: toBigInt(
            success.minResourceFee ?? success.min_resource_fee ?? BASE_FEE,
          ).toString(),
        };
      } catch (e: unknown) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : "estimate failed",
        };
      }
    });
  }

  /**
   * Cast a vote on an active proposal.
   */
  /**
   * Cast a vote on an active proposal.
   *
   * @returns The Stellar transaction hash, suitable for linking to a block explorer.
   */
  async castVote(
    signer: Keypair,
    proposalId: bigint,
    support: VoteSupport,
  ): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const supportScVal = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol(VoteSupport[support]),
      ]);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "cast_vote",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(proposalId, { type: "u64" }),
            supportScVal,
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw new Error(`castVote failed: ${JSON.stringify(result)}`);
      }
      await this.pollForConfirmation(result.hash);
      return result.hash;
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Same as {@link castVote} but signs with a wallet callback.
   */
  async castVoteWithSign(
    signerPublicKey: string,
    proposalId: bigint,
    support: VoteSupport,
    signUnsignedXdr: (xdr: string) => Promise<string>
  ): Promise<void> {
    const account = await this.server.getAccount(signerPublicKey);

    const supportScVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol(VoteSupport[support]),
    ]);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "cast_vote",
          nativeToScVal(signerPublicKey, { type: "address" }),
          nativeToScVal(proposalId, { type: "u64" }),
          supportScVal
        )
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await signUnsignedXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const result = await this.server.sendTransaction(signed);
    if (result.status === "ERROR") {
      throw new Error(`castVoteWithSign failed: ${JSON.stringify(result)}`);
    }
    await this.pollForConfirmation(result.hash);
  }

  /**
   * Cast a vote with an on-chain reason string.
   */
  async castVoteWithReason(
    signer: Keypair,
    proposalId: bigint,
    support: VoteSupport,
    reason: string,
  ): Promise<void> {
    const account = await this.server.getAccount(signer.publicKey());

    const supportScVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol(VoteSupport[support]),
    ]);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "cast_vote_with_reason",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(proposalId, { type: "u64" }),
          supportScVal,
          nativeToScVal(reason, { type: "string" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    const result = await this.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw new Error(`castVoteWithReason failed: ${JSON.stringify(result)}`);
    }
    await this.pollForConfirmation(result.hash);
  }

  /**
   * Same as {@link castVoteWithReason} but signs with a wallet callback.
   */
  async castVoteWithReasonAndSign(
    signerPublicKey: string,
    proposalId: bigint,
    support: VoteSupport,
    reason: string,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<void> {
    const account = await this.server.getAccount(signerPublicKey);

    const supportScVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol(VoteSupport[support]),
    ]);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "cast_vote_with_reason",
          nativeToScVal(signerPublicKey, { type: "address" }),
          nativeToScVal(proposalId, { type: "u64" }),
          supportScVal,
          nativeToScVal(reason, { type: "string" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await signUnsignedXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    const result = await this.server.sendTransaction(signed);
    if (result.status === "ERROR") {
      throw new Error(`castVoteWithReasonAndSign failed: ${JSON.stringify(result)}`);
    }
    await this.pollForConfirmation(result.hash);
  }

  /**
   * Cancel a proposal (can only be done by the proposer while it's Pending).
   */
  async cancel(
    signer: Keypair,
    proposalId: bigint,
  ): Promise<void> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "cancel",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(proposalId, { type: "u64" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);

      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw new Error(`Transaction failed: ${JSON.stringify(result)}`);
      }

      await this.pollForConfirmation(result.hash);
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Cancel a proposal via governance (must be called by the governor contract itself).
   *
   * This is typically used as an action in another proposal.
   *
   * @param signer The account authorizing the transaction (must be the governor itself if called directly)
   * @param proposalId The ID of the proposal to cancel
   */
  async cancelByGovernance(
    signer: Keypair,
    proposalId: bigint,
  ): Promise<void> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "cancel_by_governance",
            nativeToScVal(proposalId, { type: "u64" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);

      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw new Error(`Transaction failed: ${JSON.stringify(result)}`);
      }

      await this.pollForConfirmation(result.hash);
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Same as {@link cancelByGovernance} but signs with a wallet callback.
   */
  async cancelByGovernanceWithSign(
    signerPublicKey: string,
    proposalId: bigint,
    signUnsignedXdr: (xdr: string) => Promise<string>,
  ): Promise<void> {
    const account = await this.server.getAccount(signerPublicKey);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "cancel_by_governance",
          nativeToScVal(proposalId, { type: "u64" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    const signedXdr = await signUnsignedXdr(prepared.toXDR());
    const signed = TransactionBuilder.fromXDR(
      signedXdr,
      this.networkPassphrase,
    );

    const result = await this.server.sendTransaction(signed);
    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(result)}`);
    }

    await this.pollForConfirmation(result.hash);
  }

  /**
   * Get the current state of a proposal.
   * TODO issue #17: decode all 7 ProposalState variants.
   */
  async getProposalState(proposalId: bigint): Promise<ProposalState> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "state",
              nativeToScVal(proposalId, { type: "u64" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        throw new Error(`Simulation error: ${result.error}`);
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) throw new Error("No return value");

      return this.decodeProposalState(raw);
    });
  }

  /**
   * Decode the Soroban enum ScVal (vector-wrapped symbol) to ProposalState.
   */
  private decodeProposalState(raw: xdr.ScVal): ProposalState {
    const native = scValToNative(raw);
    if (!Array.isArray(native) || native.length === 0) {
      throw new Error("Invalid ScVal format for ProposalState enum");
    }

    const variant = native[0];
    const states: Record<string, ProposalState> = {
      Pending: ProposalState.Pending,
      Active: ProposalState.Active,
      Defeated: ProposalState.Defeated,
      Succeeded: ProposalState.Succeeded,
      Queued: ProposalState.Queued,
      Executed: ProposalState.Executed,
      Cancelled: ProposalState.Cancelled,
      Expired: ProposalState.Expired,
    };

    // DEBUG: throw info

    if (variant in states) {
      return states[variant];
    }

    throw new UnknownProposalStateError(variant);
  }

  /**
   * Poll for a proposal to reach a specific state.
   * @param proposalId The proposal ID to monitor
   * @param targetState The state to wait for
   * @param options Polling options
   * @returns Promise that resolves when the target state is reached
   */
  async waitForProposalState(
    proposalId: bigint,
    targetState: ProposalState,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<void> {
    const { timeoutMs = 300000, pollIntervalMs = 5000 } = options; // 5 min default timeout, 5 sec poll
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const currentState = await this.getProposalState(proposalId);
      if (currentState === targetState) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(
      `Timeout waiting for proposal ${proposalId} to reach state ${ProposalState[targetState]}`
    );
  }

  /**
   * Get vote breakdown for a proposal.
   */
  async getProposalVotes(proposalId: bigint): Promise<ProposalVotes> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "proposal_votes",
              nativeToScVal(proposalId, { type: "u64" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        throw new Error(`Simulation error: ${result.error}`);
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) throw new Error("No return value");

      const [votesFor, votesAgainst, votesAbstain] = scValToNative(raw) as [
        bigint,
        bigint,
        bigint,
      ];
      return { votesFor, votesAgainst, votesAbstain };
    });
  }

  /**
   * Get the quorum required for a specific proposal.
   * The quorum is calculated based on the total supply at the proposal's start ledger.
   */
  async getQuorum(proposalId: bigint): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.config.governorAddress),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "get_quorum",
              nativeToScVal(proposalId, { type: "u64" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        throw new Error(`Simulation error: ${result.error}`);
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) throw new Error("No return value");

      const quorum = BigInt(scValToNative(raw));
      return quorum;
    });
  }

  /**
   * Check if a proposal has reached quorum.
   * Returns true if the sum of for and abstain votes meets or exceeds the required quorum.
   */
  async isQuorumReached(proposalId: bigint): Promise<boolean> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.config.governorAddress),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
      )
        .addOperation(
          this.contract.call(
            "is_quorum_reached",
            nativeToScVal(proposalId, { type: "u64" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation error: ${result.error}`);
    }

    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) throw new Error("No return value");

    const isReached = scValToNative(raw) as boolean;
    return isReached;
  }

  /**
   * Check if an address has voted on a proposal.
   * Returns true if the address has cast a vote.
   */
  async hasVoted(proposalId: bigint, voter: string): Promise<boolean> {
    return this.retry(async () => {
      try {
        const result = await this.server.simulateTransaction(
          new TransactionBuilder(
            await this.server.getAccount(this.readAccount()),
            { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
          )
            .addOperation(
              this.contract.call(
                "has_voted",
                nativeToScVal(proposalId, { type: "u64" }),
                nativeToScVal(voter, { type: "address" })
              )
            )
            .setTimeout(30)
            .build()
        );

        if (SorobanRpc.Api.isSimulationError(result)) {
          return false;
        }

        const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
          .result?.retval;
        return raw ? Boolean(scValToNative(raw)) : false;
      } catch {
        return false;
      }
    });
  }

  /**
   * Check whether an address can currently submit a proposal.
   *
   * This combines all proposal eligibility checks into a single RPC call:
   * paused state, proposal threshold, cooldown period, and rate limit per period.
   *
   * @param proposer The address to check
   * @returns A structured result indicating if the address is allowed to propose
   */
  async canPropose(proposer: string): Promise<CanProposeResult> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.config.governorAddress),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "can_propose",
              nativeToScVal(proposer, { type: "address" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        throw new Error(`Simulation error: ${result.error}`);
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) throw new Error("No return value");

      const native = scValToNative(raw) as Record<string, unknown>;
      return {
        allowed: Boolean(native.allowed),
        reason: String(native.reason ?? "unknown"),
        cooldownEndsAt: native.cooldown_ends_at 
          ? Number(native.cooldown_ends_at) 
          : undefined,
        proposalsThisPeriod: Number(native.proposals_this_period ?? 0),
        maxPerPeriod: Number(native.max_per_period ?? 0),
        votingPower: toBigInt(native.voting_power ?? 0),
        threshold: toBigInt(native.threshold ?? 0),
      };
    });
  }

  /**
   * Get voting history for a specific address across all proposals.
   *
   * Scans VoteCast/vote events filtering by voter address. If an indexer is configured
   * via the indexerUrl in GovernorConfig, it will use the indexer API for faster results.
   *
   * @param voter The address to get voting history for
   * @param opts Optional parameters for pagination
   * @returns Array of voting history entries sorted by ledger descending (most recent first)
   */
  async getVotingHistory(
    voter: string,
    opts?: { fromLedger?: number; limit?: number }
  ): Promise<VotingHistoryEntry[]> {
    const limit = opts?.limit ?? 50;
    
    // Try indexer first if configured
    if (this.config.indexerUrl) {
      try {
        const response = await fetch(`${this.config.indexerUrl}/profile/${voter}`);
        if (response.ok) {
          const data = await response.json() as { votes?: any[] };
          const votes = data.votes || [];
          return votes
            .map((v: any) => ({
              proposalId: toBigInt(v.proposal_id),
              support: v.support,
              weight: toBigInt(v.weight),
              reason: v.reason,
              ledger: Number(v.ledger),
            }))
            .sort((a: VotingHistoryEntry, b: VotingHistoryEntry) => b.ledger - a.ledger)
            .slice(0, limit);
        }
      } catch (e) {
        console.warn("Indexer query failed, falling back to event scan:", e);
      }
    }

    // Fallback to event scanning
    return this.retry(async () => {
      const events = await this.server.getEvents({
        startLedger: opts?.fromLedger ?? 1,
        filters: [
          {
            type: "contract",
            contractIds: [this.config.governorAddress],
            topics: [["VoteCast", "vote"], [voter]],
          },
        ],
        limit: limit * 2,
      });

      const history: VotingHistoryEntry[] = [];
      for (const event of events.events) {
        if (!event.topic || event.topic.length < 2) continue;

        // Check if voter matches (second topic)
        const voterTopic = scValToNative(event.topic[1]);
        if (String(voterTopic) !== voter) continue;

        // Parse event data
        const data = event.value;
        if (!data) continue;

        const native = scValToNative(data) as Record<string, unknown>;
        const proposalId = toBigInt(native.proposal_id ?? native.proposalId);
        const supportRaw = native.support ?? native.support;
        const support = typeof supportRaw === "number" 
          ? supportRaw 
          : Number(supportRaw);
        const weight = toBigInt(native.weight ?? 0);
        const reason = native.reason as string | undefined;
        const ledger = Number(event.ledger);

        history.push({
          proposalId,
          support: support as VoteSupport,
          weight,
          reason,
          ledger,
        });
      }

      // Sort by ledger descending and apply limit
      return history
        .sort((a, b) => b.ledger - a.ledger)
        .slice(0, limit);
    });
  }

  /** Current Soroban ledger sequence from the RPC backing this client. */
  async getLatestLedger(): Promise<number> {
    return this.retry(async () => {
      const info = await this.server.getLatestLedger();
      return info.sequence;
    });
  }

  /**
   * Poll `getProposalState` until the state changes (compared to the prior poll).
   *
   * The first successful poll establishes a baseline and does **not** invoke `onChange`.
   * Unsubscribe with the returned function to stop polling.
   */
  onProposalStateChange(
    proposalId: bigint,
    onChange: (newState: ProposalState) => void,
    pollIntervalMs: number = 10_000,
  ): () => void {
    let stopped = false;
    let previous: ProposalState | undefined;

    const tick = async () => {
      if (stopped) return;
      try {
        const state = await this.getProposalState(proposalId);
        if (previous !== undefined && state !== previous) {
          onChange(state);
        }
        previous = state;
      } catch {
        // Transient RPC errors — retry on next tick
      }
    };

    void tick();
    const handle = setInterval(() => void tick(), pollIntervalMs);
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }

  /**
   * Get total number of proposals.
   */
  async proposalCount(): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(this.contract.call("proposal_count"))
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return 0n;

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? BigInt(scValToNative(raw)) : 0n;
    });
  }

  /**
   * Get a single proposal from the indexer API (fast path).
   * Falls back to on-chain queries if indexer is unavailable.
   * 
   * @param proposalId The proposal ID to fetch
   * @param indexerUrl Optional indexer API URL (defaults to environment variable)
   * @returns The proposal data or null if not found
   */
  async getProposalFromIndexer(
    proposalId: bigint, 
    indexerUrl?: string
  ): Promise<any | null> {
    const url = indexerUrl || this.config.indexerUrl;
    
    if (!url) {
      // No indexer configured, fall back to on-chain query
      console.warn("No indexer URL configured, falling back to on-chain queries");
      return null;
    }

    try {
      const response = await fetch(`${url}/proposals/${proposalId}`);
      
      if (response.status === 404) {
        return null;
      }
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      console.warn(`Indexer query failed for proposal ${proposalId}:`, error);
      return null;
    }
  }

  async getProposalExpiryLedger(proposalId: bigint): Promise<number> {
    const proposal = await this.getProposal(proposalId);
    const settings = await this.getSettings();
    return proposal.endLedger + settings.proposalGracePeriod;
  }

  async getGuardianActivity(
    fromLedger?: number,
  ): Promise<{
    proposalId: bigint;
    canceller: string;
    ledger: number;
  }[]> {
    const settings = await this.getSettings();
    const guardianAddress = settings.guardian;
    if (!guardianAddress) return [];

    const contractId = this.contract.contractId();
    const topicFilter = [xdr.ScVal.scvSymbol("ProposalCancelled")];
    const results: {
      proposalId: bigint;
      canceller: string;
      ledger: number;
    }[] = [];

    let cursor = fromLedger ?? 1;
    const latest = await this.getLatestLedger();

    while (cursor <= latest) {
      const response = await this.retry(async () => {
        return await this.server.getEvents({
          startLedger: cursor,
          filters: [
            {
              type: "contract",
              contractIds: [contractId],
              topics: [topicFilter.map((v) => v.toXDR("base64"))],
            },
          ],
          limit: 100,
        });
      });

      const events = response.events ?? [];
      if (events.length === 0) break;

      let maxLedger = cursor;
      for (const event of events) {
        try {
          const value = scValToNative(event.value) as Record<string, unknown>;
          const proposalIdValue = value.proposal_id;
          const caller = String(value.caller ?? "");
          const proposalId = BigInt(proposalIdValue as number | bigint | string);
          const ledger = event.ledger;
          if (caller === guardianAddress) {
            results.push({ proposalId, canceller: caller, ledger });
          }
        } catch {
          // ignore malformed event
        }
        if (event.ledger > maxLedger) maxLedger = event.ledger;
      }

      cursor = maxLedger + 1;
    }

    return results;
  }

  /**
   * List proposals created by a given address by scanning `ProposalCreated`
   * (and legacy `prop_crtd`) events and then fetching each proposal/state.
   *
   * Results are sorted newest first.
   */
  async getProposalsForAddress(
    proposer: string,
    opts?: { fromLedger?: number; limit?: number },
  ): Promise<Array<{ id: bigint; proposal: Proposal; state: ProposalState }>> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
    const contractId = this.contract.contractId();
    const proposerTopic = nativeToScVal(proposer, { type: "address" }).toXDR(
      "base64",
    );

    const topicVectors = [
      [
        xdr.ScVal.scvSymbol("ProposalCreated").toXDR("base64"),
        proposerTopic,
      ],
      [xdr.ScVal.scvSymbol("prop_crtd").toXDR("base64"), proposerTopic],
    ];

    const latest = await this.getLatestLedger();
    let startLedger = opts?.fromLedger ?? 1;
    if (startLedger < 1) startLedger = 1;

    const proposalIds: Array<{ id: bigint; ledger: number }> = [];

    for (const topics of topicVectors) {
      let cursor = startLedger;
      while (cursor <= latest) {
        const response = await this.retry(async () => {
          return await this.server.getEvents({
            startLedger: cursor,
            filters: [
              {
                type: "contract",
                contractIds: [contractId],
                topics: [topics],
              },
            ],
            limit: 100,
          });
        }, this.isNetworkError.bind(this));

        const events = response.events ?? [];
        if (events.length === 0) break;

        let maxLedger = cursor;
        for (const event of events) {
          try {
            const symbol = scValToNative(event.topic[0]);
            const value = scValToNative(event.value) as any;
            const proposalIdRaw =
              symbol === "ProposalCreated"
                ? value?.proposal_id
                : Array.isArray(value)
                  ? value[0]
                  : undefined;

            const id = BigInt(proposalIdRaw as number | bigint | string);
            proposalIds.push({ id, ledger: event.ledger });
          } catch {
            // ignore malformed event
          }
          if (event.ledger > maxLedger) maxLedger = event.ledger;
        }

        cursor = maxLedger + 1;
      }
    }

    const uniq = new Map<string, { id: bigint; ledger: number }>();
    for (const entry of proposalIds) {
      const key = entry.id.toString();
      const prev = uniq.get(key);
      if (!prev || entry.ledger > prev.ledger) uniq.set(key, entry);
    }

    const newestFirst = Array.from(uniq.values())
      .sort((a, b) => b.ledger - a.ledger)
      .slice(0, limit);

    const hydrated = await Promise.all(
      newestFirst.map(async ({ id }) => {
        const [proposal, state] = await Promise.all([
          this.getProposal(id),
          this.getProposalState(id),
        ]);
        return { id, proposal, state };
      }),
    );

    return hydrated;
  }

  /**
   * Return recent on-chain votes cast by a voter by scanning `VoteCast` events.
   * Useful for profile pages without requiring an indexer endpoint.
   */
  async getVotesCastByAddress(
    voter: string,
    opts?: { fromLedger?: number; limit?: number },
  ): Promise<
    Array<{
      proposalId: bigint;
      support: VoteSupport;
      weight: bigint;
      ledger: number;
    }>
  > {
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 200));
    const contractId = this.contract.contractId();
    const topic = [
      xdr.ScVal.scvSymbol("VoteCast").toXDR("base64"),
      nativeToScVal(voter, { type: "address" }).toXDR("base64"),
    ];

    const latest = await this.getLatestLedger();
    let cursor = opts?.fromLedger ?? 1;
    if (cursor < 1) cursor = 1;

    const results: Array<{
      proposalId: bigint;
      support: VoteSupport;
      weight: bigint;
      ledger: number;
    }> = [];

    while (cursor <= latest) {
      const response = await this.retry(async () => {
        return await this.server.getEvents({
          startLedger: cursor,
          filters: [
            {
              type: "contract",
              contractIds: [contractId],
              topics: [topic],
            },
          ],
          limit: 100,
        });
      }, this.isNetworkError.bind(this));

      const events = response.events ?? [];
      if (events.length === 0) break;

      let maxLedger = cursor;
      for (const event of events) {
        try {
          const value = scValToNative(event.value) as any;
          const proposalId = BigInt(value?.proposal_id);
          const supportRaw = Number(value?.support);
          const weight = BigInt(value?.weight ?? 0);

          const support =
            supportRaw === 0
              ? VoteSupport.Against
              : supportRaw === 1
                ? VoteSupport.For
                : VoteSupport.Abstain;

          results.push({ proposalId, support, weight, ledger: event.ledger });
        } catch {
          // ignore malformed event
        }
        if (event.ledger > maxLedger) maxLedger = event.ledger;
      }

      if (results.length >= limit) break;
      cursor = maxLedger + 1;
    }

    return results
      .sort((a, b) => b.ledger - a.ledger)
      .slice(0, limit);
  }

  async getLastProposalLedger(address: string): Promise<number> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.config.governorAddress),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "last_proposal_ledger",
              nativeToScVal(address, { type: "address" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );
      if (SorobanRpc.Api.isSimulationError(result)) return 0;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? Number(scValToNative(raw)) : 0;
    });
  }

  async getProposalsInPeriod(address: string): Promise<number> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.config.governorAddress),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "proposals_in_period",
              nativeToScVal(address, { type: "address" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );
      if (SorobanRpc.Api.isSimulationError(result)) return 0;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? Number(scValToNative(raw)) : 0;
    });
  }

  /**
   * Get the voting receipt for a specific voter on a proposal.
   *
   * Returns whether the voter has voted, their support choice, vote weight, and reason.
   */
  async getReceipt(
    proposalId: bigint,
    voter: string,
  ): Promise<{
    hasVoted: boolean;
    support: VoteSupport;
    weight: bigint;
    reason: string;
  }> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "get_receipt",
              nativeToScVal(proposalId, { type: "u64" }),
              nativeToScVal(voter, { type: "address" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        return {
          hasVoted: false,
          support: VoteSupport.Against,
          weight: 0n,
          reason: "",
        };
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) {
        return {
          hasVoted: false,
          support: VoteSupport.Against,
          weight: 0n,
          reason: "",
        };
      }

      const receipt = scValToNative(raw) as {
        has_voted: boolean;
        support: string[];
        weight: bigint;
        reason: string;
      };

      // Decode support enum (vector-wrapped symbol)
      const supportMap: Record<string, VoteSupport> = {
        Against: VoteSupport.Against,
        For: VoteSupport.For,
        Abstain: VoteSupport.Abstain,
      };
      const supportVariant = receipt.support[0];
      const support = supportMap[supportVariant] ?? VoteSupport.Against;

      return {
        hasVoted: receipt.has_voted,
        support,
        weight: BigInt(receipt.weight),
        reason: receipt.reason,
      };
    });
  }

  /**
   * Return the on-chain vote reason for a voter on a proposal.
   * Empty string means no reason recorded.
   */
  async getVoteReason(proposalId: bigint, voter: string): Promise<string> {
    const receipt = await this.getReceipt(proposalId, voter);
    return receipt.reason ?? "";
  }

  /**
   * Validate settings before building or submitting an update_config proposal.
   */
  validateGovernorSettings(
    newSettings: GovernorSettings,
    limits: GovernorSettingsValidationLimits = {},
  ): void {
    const maxVotingDelay = limits.maxVotingDelay ?? DEFAULT_MAX_VOTING_DELAY;
    const minVotingPeriod = limits.minVotingPeriod ?? DEFAULT_MIN_VOTING_PERIOD;

    if (
      !Number.isInteger(newSettings.votingDelay) ||
      newSettings.votingDelay < 0 ||
      newSettings.votingDelay > maxVotingDelay
    ) {
      throw new GovernorError(
        GovernorErrorCode.InvalidArguments,
        `votingDelay must be between 0 and ${maxVotingDelay}`,
      );
    }
    if (
      !Number.isInteger(newSettings.votingPeriod) ||
      newSettings.votingPeriod < minVotingPeriod
    ) {
      throw new GovernorError(
        GovernorErrorCode.InvalidArguments,
        `votingPeriod must be at least ${minVotingPeriod}`,
      );
    }
    if (
      !Number.isInteger(newSettings.quorumNumerator) ||
      newSettings.quorumNumerator <= 0 ||
      newSettings.quorumNumerator > 100
    ) {
      throw new GovernorError(
        GovernorErrorCode.InvalidArguments,
        "quorumNumerator must be greater than 0 and at most 100",
      );
    }
    if (newSettings.proposalThreshold < 0n) {
      throw new GovernorError(
        GovernorErrorCode.InvalidArguments,
        "proposalThreshold must be greater than or equal to 0",
      );
    }
  }

  /**
   * Build calldata for an update_config proposal.
   *
   * Returns the target, function name, and encoded calldata to pass to propose().
   */
  buildUpdateConfigProposal(
    newSettings: GovernorSettings,
    limits: GovernorSettingsValidationLimits = {},
  ): {
    target: string;
    fnName: string;
    calldata: Uint8Array;
  } {
    this.validateGovernorSettings(newSettings, limits);
    const useDynamicQuorum = newSettings.useDynamicQuorum ?? false;
    const minQuorumUsd = newSettings.minQuorumUsd ?? 0n;
    const maxCalldataSize = newSettings.maxCalldataSize ?? 10_000;
    const proposalCooldown = newSettings.proposalCooldown ?? 100;
    const maxProposalsPerPeriod = newSettings.maxProposalsPerPeriod ?? 5;
    const proposalPeriodDuration = newSettings.proposalPeriodDuration ?? 10_000;

    const settingsScVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("voting_delay"),
        val: nativeToScVal(newSettings.votingDelay, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("voting_period"),
        val: nativeToScVal(newSettings.votingPeriod, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("quorum_numerator"),
        val: nativeToScVal(newSettings.quorumNumerator, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("proposal_threshold"),
        val: nativeToScVal(newSettings.proposalThreshold, { type: "i128" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("guardian"),
        val: nativeToScVal(newSettings.guardian, { type: "address" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("vote_type"),
        val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(newSettings.voteType)]),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("proposal_grace_period"),
        val: nativeToScVal(newSettings.proposalGracePeriod, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("use_dynamic_quorum"),
        val: xdr.ScVal.scvBool(useDynamicQuorum),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("reflector_oracle"),
        val: newSettings.reflectorOracle
          ? nativeToScVal(newSettings.reflectorOracle, { type: "address" })
          : xdr.ScVal.scvVoid(),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("min_quorum_usd"),
        val: nativeToScVal(minQuorumUsd, { type: "i128" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("max_calldata_size"),
        val: nativeToScVal(maxCalldataSize, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("proposal_cooldown"),
        val: nativeToScVal(proposalCooldown, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("max_proposals_per_period"),
        val: nativeToScVal(maxProposalsPerPeriod, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("proposal_period_duration"),
        val: nativeToScVal(proposalPeriodDuration, { type: "u32" }),
      }),
    ]);

    return {
      target: this.config.governorAddress,
      fnName: "update_config",
      calldata: settingsScVal.toXDR(),
    };
  }

  // --- Internal ---

  private readAccount(sourceAccount?: string): string {
    return (
      sourceAccount ??
      this.config.simulationAccount ??
      this.config.governorAddress
    );
  }

  private async pollForConfirmation(
    hash: string,
    retries = 10,
    delayMs = 2000,
  ): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
    for (let i = 0; i < retries; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      const status = await this.server.getTransaction(hash);
      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return status as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      }
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction failed: ${hash}`);
      }
    }
    throw new Error(`Transaction not confirmed after ${retries} retries`);
  }

  /**
   * Fetch a proposal by its ID.
   */
  async getProposal(proposalId: bigint): Promise<Proposal> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
        )
          .addOperation(
            this.contract.call("get_proposal", nativeToScVal(proposalId, { type: "u64" }))
          )
          .setTimeout(30)
          .build()
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        throw new Error(`Simulation error: ${result.error}`);
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) throw new Error("No return value");

      return scValToNative(raw) as Proposal;
    });
  }

  /**
   * Fetch the ledger sequence when a proposal was queued.
   * Returns 0 if the proposal was not queued.
   */
  async getQueueTime(proposalId: bigint): Promise<number> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
        )
          .addOperation(
            this.contract.call("get_queue_time", nativeToScVal(proposalId, { type: "u64" }))
          )
          .setTimeout(30)
          .build()
      );

      if (SorobanRpc.Api.isSimulationError(result)) return 0;

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? (scValToNative(raw) as number) : 0;
    });
  }

  /**
   * Fetch the timelock operation IDs for a queued proposal.
   * Returns an empty array if the proposal has not been queued.
   */
  async getQueuedOpIds(proposalId: bigint): Promise<string[]> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase }
        )
          .addOperation(
            this.contract.call("get_queued_op_ids", nativeToScVal(proposalId, { type: "u64" }))
          )
          .setTimeout(30)
          .build()
      );

      if (SorobanRpc.Api.isSimulationError(result)) return [];

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) return [];

      const opIds = scValToNative(raw) as Buffer[] | string[];
      return opIds.map((id) => 
        Buffer.isBuffer(id) ? id.toString("hex") : id
      );
    });
  }

  /**
   * Fetch timelock-related timings for a queued proposal.
   */
  async getTimelockInfo(proposalId: bigint): Promise<TimelockInfo> {
    const queueLedger = await this.getQueueTime(proposalId);
    if (queueLedger === 0) {
      throw new Error(`Proposal ${proposalId} not queued or not found`);
    }

    const [settings, timelockClient] = await Promise.all([
      this.getSettings(),
      Promise.resolve(new TimelockClient(this.config)),
    ]);

    const [minDelay, executionWindow] = await Promise.all([
      timelockClient.minDelay(),
      timelockClient.executionWindow(),
    ]);

    // Executable after min_delay
    const executableAtLedger = queueLedger + Math.floor(Number(minDelay) / 10);
    
    // Per requirement: Use QueueTime + voting_delay/10 for veto window end
    const vetoWindowEndLedger = queueLedger + Math.floor(settings.votingDelay / 10);
    
    // Deadline after execution_window
    const executionDeadlineLedger = executableAtLedger + Math.floor(Number(executionWindow) / 10);

    return {
      queueLedger,
      vetoWindowEndLedger,
      executableAtLedger,
      executionDeadlineLedger,
    };
  }

  /**
   * Fetch multiple proposals in a single round-trip using parallel Promise.all.
   *
   * Reduces N sequential RPC calls to a single parallel batch. An optional
   * concurrency limit (default 10) prevents overwhelming the RPC endpoint.
   *
   * @param proposalIds Array of proposal IDs to fetch
   * @param concurrency Max simultaneous RPC calls (default 10)
   * @returns Array of results — resolved Proposal or Error for each ID
   */
  async getProposalsBatch(
    proposalIds: bigint[],
    concurrency = 10,
  ): Promise<Array<{ id: bigint; proposal?: Proposal; error?: Error }>> {
    const results: Array<{ id: bigint; proposal?: Proposal; error?: Error }> = [];

    for (let i = 0; i < proposalIds.length; i += concurrency) {
      const chunk = proposalIds.slice(i, i + concurrency);
      const settled = await Promise.allSettled(
        chunk.map((id) => this.getProposal(id)),
      );
      for (let j = 0; j < chunk.length; j++) {
        const outcome = settled[j];
        if (outcome.status === "fulfilled") {
          results.push({ id: chunk[j], proposal: outcome.value });
        } else {
          results.push({ id: chunk[j], error: outcome.reason as Error });
        }
      }
    }

    return results;
  }

  /**
   * Fetch state + votes for multiple proposals in parallel.
   *
   * Useful for the proposals list page — replaces sequential fetching with a
   * single batched round-trip per chunk of proposals.
   *
   * @param proposalIds Array of proposal IDs to query
   * @param concurrency Max simultaneous RPC calls (default 10)
   */
  async getProposalsSummaryBatch(
    proposalIds: bigint[],
    concurrency = 10,
  ): Promise<Array<{ id: bigint; state?: ProposalState; votes?: ProposalVotes; error?: Error }>> {
    const results: Array<{ id: bigint; state?: ProposalState; votes?: ProposalVotes; error?: Error }> = [];

    for (let i = 0; i < proposalIds.length; i += concurrency) {
      const chunk = proposalIds.slice(i, i + concurrency);
      const settled = await Promise.allSettled(
        chunk.map((id) =>
          Promise.all([
            this.getProposalState(id),
            this.getProposalVotes(id),
          ]),
        ),
      );
      for (let j = 0; j < chunk.length; j++) {
        const outcome = settled[j];
        if (outcome.status === "fulfilled") {
          const [state, votes] = outcome.value;
          results.push({ id: chunk[j], state, votes });
        } else {
          results.push({ id: chunk[j], error: outcome.reason as Error });
        }
      }
    }

    return results;
  }
}

/**
 * Compute SHA-256 hash of a proposal description.
 *
 * This function uses the Web Crypto API in browser environments and
 * Node.js crypto module in server-side environments. The input is
 * UTF-8 encoded before hashing, and the output is a 64-character
 * lowercase hex string.
 *
 * @param text - The proposal description text to hash
 * @returns Hex-encoded SHA-256 hash (64 lowercase characters)
 */
export async function hashDescription(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);

  // Use Web Crypto API (available in both browser and Node.js 18+)
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Fallback to Node.js crypto module
  if (typeof require !== "undefined") {
    try {
      const cryptoNode = require("crypto");
      const hash = cryptoNode.createHash("sha256").update(data).digest("hex");
      return hash;
    } catch (e) {
      // ignore and try next fallback
    }
  }

  throw new Error("No crypto API available in this environment");
}

/**
 * Synchronous version of hashDescription for environments where async is not needed.
 * Uses the same algorithm and encoding.
 */
export function hashDescriptionSync(text: string): string {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);

  // Try Node.js crypto first (synchronous)
  if (typeof require !== "undefined") {
    try {
      const cryptoNode = require("crypto");
      const hash = cryptoNode.createHash("sha256").update(data).digest("hex");
      return hash;
    } catch (e) {
      // ignore and try next fallback
    }
  }

  throw new Error("Synchronous SHA-256 is only available in Node.js environments. Use async hashDescription instead.");
}

/**
 * Upload proposal description to IPFS and compute its SHA-256 hash.
 *
 * This helper simplifies the "Step 1" of creating a proposal by handling
 * the IPFS pinning (via Pinata or custom uploader) and generating the
 * description_hash required by the governor contract.
 *
 * @param description - The full text description of the proposal
 * @param options - Upload credentials and provider selection
 * @returns The IPFS URI (ipfs://...) and hex-encoded SHA-256 hash
 */
export async function uploadProposalMetadata(
  description: string,
  options: MetadataUploadOptions,
): Promise<{ uri: string; hash: string }> {
  const hash = await hashDescription(description);
  let uri = "";

  if (options.customUploader) {
    uri = await options.customUploader(description);
  } else if (options.pinataApiKey) {
    // Pinata API implementation
    // We use the JSON pinning endpoint: https://api.pinata.cloud/pinning/pinJSONToIPFS
    const body = {
      pinataContent: {
        description,
        version: "1.0",
      },
      pinataMetadata: {
        name: `nebgov-proposal-${hash.substring(0, 8)}`,
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (options.pinataSecretKey) {
      // Legacy API Key + Secret pair
      headers["pinata_api_key"] = options.pinataApiKey;
      headers["pinata_secret_api_key"] = options.pinataSecretKey;
    } else {
      // Modern JWT
      headers["Authorization"] = `Bearer ${options.pinataApiKey}`;
    }

    const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Pinata upload failed: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as { IpfsHash: string };
    uri = `ipfs://${data.IpfsHash}`;
  } else {
    throw new Error("No IPFS upload provider configured in options");
  }

  return { uri, hash };
}
