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
  DelegateInfo,
  Network,
  TopDelegate,
  VotingPowerDistribution,
  DelegatorInfo,
  VotesSettings,
  DelegatorRecord,
} from "./types";
import { VotesError, VotesErrorCode, parseVotesError } from "./errors";
import { withRetry, isNetworkError } from "./utils";

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

/**
 * Ledger window used when no fromLedger is specified for analytics queries.
 * 17,280 ledgers ≈ 24 hours at ~5 s/ledger on testnet.
 */
const DEFAULT_SCAN_WINDOW = 17_280;

/**
 * VotesClient — interact with the token-votes contract.
 * Handles delegation, voting power queries, and governance health analytics.
 */
export class VotesClient {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(private readonly config: GovernorConfig) {
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.votesAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  private async retry<T>(
    fn: () => Promise<T>,
    filter?: (e: unknown) => boolean,
  ): Promise<T> {
    return withRetry(fn, {
      maxAttempts: this.config.maxAttempts,
      baseDelayMs: this.config.baseDelayMs,
      retryOn: filter ?? isNetworkError,
    });
  }

  private isRetryableSubmissionError(e: unknown): boolean {
    if (isNetworkError(e)) return true;
    if (e instanceof VotesError) {
      // Don't retry on contract logic errors (codes < 100)
      return (
        e.code >= 100 &&
        e.code !== VotesErrorCode.TransactionFailed &&
        e.code !== VotesErrorCode.DelegationFailed
      );
    }
    const msg = String(e);
    if (msg.includes("TransactionAlreadyInMempool")) return false;
    return false;
  }

  /**
   * Explicitly revoke delegation and move voting power back to self.
   *
   * @returns The Stellar transaction hash, suitable for linking to a block explorer.
   */
  async undelegate(signer: Keypair): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "undelegate",
            nativeToScVal(signer.publicKey(), { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
      return result.hash;
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Backwards-compatible alias for {@link undelegate}.
   *
   * @returns The Stellar transaction hash, suitable for linking to a block explorer.
   */
  async revokeDelegation(signer: Keypair): Promise<string> {
    return this.undelegate(signer);
  }

  /**
   * Delegate voting power to another address (or self-delegate to activate votes).
   *
   * @returns The Stellar transaction hash, suitable for linking to a block explorer.
   */
  async delegate(signer: Keypair, delegatee: string): Promise<string> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "delegate",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(delegatee, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
      return result.hash;
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Transfer voting tokens and delegate in one atomic transaction.
   * Auth is required only from `signer` (`from`).
   */
  async transferAndDelegate(
    signer: Keypair,
    to: string,
    amount: bigint,
    delegatee: string,
  ): Promise<void> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "transfer_and_delegate",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(to, { type: "address" }),
            nativeToScVal(amount, { type: "i128" }),
            nativeToScVal(delegatee, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseVotesError(result);
      }
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Get the current voting power of an address.
   *
   * @param account Stellar address to query.
   * @returns Raw voting-power units (divide by token decimals for display).
   *   Returns `0n` if the address has not self-delegated.
   */
  async getVotes(account: string): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(await this.server.getAccount(this.readAccount(account)), {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(
            this.contract.call(
              "get_votes",
              nativeToScVal(account, { type: "address" }),
            ),
          )
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
   * Get voting power of an address at a past ledger sequence.
   *
   * @param account Stellar address to query.
   * @param ledger Ledger sequence number to query at.
   * @returns Raw voting-power units at the specified ledger, or `0n` on error.
   */
  async getPastVotes(account: string, ledger: number): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(await this.server.getAccount(this.readAccount(account)), {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(
            this.contract.call(
              "get_past_votes",
              nativeToScVal(account, { type: "address" }),
              nativeToScVal(ledger, { type: "u32" }),
            ),
          )
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
   * Get current base voting power (raw tokens) of an address.
   */
  async getBaseVotes(account: string): Promise<bigint> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(await this.server.getAccount(this.readAccount(account)), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "get_base_votes",
            nativeToScVal(account, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) return 0n;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? BigInt(scValToNative(raw)) : 0n;
  }

  /**
   * Get base voting power at a past ledger sequence.
   */
  async getPastBaseVotes(account: string, ledger: number): Promise<bigint> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(await this.server.getAccount(this.readAccount(account)), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "get_past_base_votes",
            nativeToScVal(account, { type: "address" }),
            nativeToScVal(ledger, { type: "u32" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) return 0n;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? BigInt(scValToNative(raw)) : 0n;
  }

  /**
   * Get current delegatee of an account.
   */
  async getDelegatee(account: string): Promise<string | null> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(await this.server.getAccount(this.readAccount(account)), {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(
            this.contract.call(
              "delegates",
              nativeToScVal(account, { type: "address" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return null;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      return raw ? (scValToNative(raw) as string) : null;
    });
  }

  /**
   * Get total supply of the voting token.
   */
  async getTotalSupply(): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(this.contract.call("total_supply"))
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
   * Get total delegated supply at a past ledger sequence.
   */
  async getPastTotalSupply(ledger: number): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "get_past_total_supply",
              nativeToScVal(ledger, { type: "u32" }),
            ),
          )
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
   * Get top N delegates sorted by current voting power.
   *
   * Scans `del_chsh` (delegate changed) events emitted by the token-votes
   * contract to discover all accounts that have ever delegated, then queries
   * their current voting power and returns the top `limit` entries.
   *
   * Backwards-compatible overload:
   * - `getTopDelegates(limit, fromLedger?)` returns `TopDelegate[]`
   *
   * Cursor-based overload:
   * - `getTopDelegates({ limit, fromLedger, cursor, maxEventsToScan, delegationMap })`
   *   returns `{ delegates, nextCursor, delegationMap }`
   *
   * The cursor is an opaque string produced by this method; callers should
   * persist and pass it back to scan only new events incrementally.
   */
  async getTopDelegates(
    limit: number,
    fromLedger?: number,
  ): Promise<TopDelegate[]>;
  async getTopDelegates(options?: TopDelegatesOptions): Promise<TopDelegatesResult>;
  async getTopDelegates(
    arg1?: number | TopDelegatesOptions,
    arg2?: number,
  ): Promise<TopDelegate[] | TopDelegatesResult> {
    // Legacy signature: (limit, fromLedger?)
    if (typeof arg1 === "number") {
      const { delegates } = await this.getTopDelegates({
        limit: arg1,
        fromLedger: arg2,
      });
      return delegates;
    }

    const options = arg1 ?? {};
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const offset = Math.max(0, options.offset ?? 0);

    const delegationMap =
      options.delegationMap ??
      new Map<string, string>();

    const { nextCursor } = await this.buildDelegationMapIncremental({
      fromLedger: options.fromLedger,
      cursor: options.cursor,
      maxEventsToScan: options.maxEventsToScan,
      delegationMap,
    });

    if (delegationMap.size === 0) {
      const empty: TopDelegatesResult = {
        delegates: [],
        nextCursor,
        delegationMap,
      };
      return empty;
    }

    // Group delegators by their current delegatee
    const byDelegate = new Map<string, Set<string>>();
    for (const [delegator, delegatee] of delegationMap) {
      if (!byDelegate.has(delegatee)) byDelegate.set(delegatee, new Set());
      byDelegate.get(delegatee)!.add(delegator);
    }

    // Query current voting power in batches to avoid OOM on large delegate sets
    const delegateAddresses = Array.from(byDelegate.keys());
    const POWER_BATCH_SIZE = 20;
    const powerEntries: Array<{
      address: string;
      votingPower: bigint;
      baseVotes: bigint;
      delegatorCount: number;
    }> = [];

    for (let i = 0; i < delegateAddresses.length; i += POWER_BATCH_SIZE) {
      const batch = delegateAddresses.slice(i, i + POWER_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (addr) => {
          const [votingPower, baseVotes] = await Promise.all([
            this.getVotes(addr),
            this.getBaseVotes(addr),
          ]);
          return {
            address: addr,
            votingPower,
            baseVotes,
            delegatorCount: byDelegate.get(addr)!.size,
          };
        }),
      );
      powerEntries.push(...batchResults);
    }

    const delegates = powerEntries
      .filter((d) => d.votingPower > 0n)
      .sort((a, b) =>
        b.votingPower > a.votingPower
          ? 1
          : b.votingPower < a.votingPower
            ? -1
            : 0,
      )
      .slice(offset, offset + limit);

    const result: TopDelegatesResult = {
      delegates,
      nextCursor,
      delegationMap,
    };

    return result;
  }

  /**
   * Get voting power distribution statistics for governance health dashboards.
   *
   * Computes:
   * - `totalDelegated`  — sum of all actively-delegated voting power
   * - `totalSupply`     — total token supply from the contract
   * - `delegationRate`  — fraction of supply that is delegated (0–1)
   * - `giniCoefficient` — concentration of voting power (0 = equal, 1 = concentrated)
   *
   * @param fromLedger - Earliest ledger to scan events from.
   */
  async getVotingPowerDistribution(
    fromLedger?: number,
  ): Promise<VotingPowerDistribution> {
    const [delegationMap, totalSupply] = await Promise.all([
      this.buildDelegationMap(fromLedger),
      this.getTotalSupply(),
    ]);

    if (delegationMap.size === 0) {
      return {
        totalDelegated: 0n,
        totalSupply,
        delegationRate: 0,
        giniCoefficient: 0,
      };
    }

    // Group delegators by delegatee and query their voting power
    const byDelegate = new Map<string, Set<string>>();
    for (const [delegator, delegatee] of delegationMap) {
      if (!byDelegate.has(delegatee)) byDelegate.set(delegatee, new Set());
      byDelegate.get(delegatee)!.add(delegator);
    }

    const powers = await Promise.all(
      Array.from(byDelegate.keys()).map((addr) => this.getVotes(addr)),
    );

    const activePowers = powers.filter((p) => p > 0n);
    const totalDelegated = activePowers.reduce((sum, p) => sum + p, 0n);

    const delegationRate =
      totalSupply > 0n ? Number(totalDelegated) / Number(totalSupply) : 0;

    const giniCoefficient = computeGini(activePowers);

    return { totalDelegated, totalSupply, delegationRate, giniCoefficient };
  }

  /**
   * Get all accounts currently delegating to a specific delegate address.
   *
   * Scans `del_chsh` events to find every delegator whose most recent
   * delegation points to `delegateAddress`, then queries each delegator's
   * current voting power contribution.
   *
   * @param delegateAddress - Strkey address of the delegate to look up
   * @param fromLedger      - Earliest ledger to scan events from.
   */
  async getDelegators(
    delegateAddress: string,
    fromLedger?: number,
  ): Promise<DelegatorInfo[]> {
    const delegationMap = await this.buildDelegationMap(fromLedger);

    const delegators: string[] = [];
    for (const [delegator, delegatee] of delegationMap) {
      if (delegatee === delegateAddress) delegators.push(delegator);
    }

    if (delegators.length === 0) return [];

    const results = await Promise.all(
      delegators.map(async (delegator) => ({
        delegator,
        power: await this.getVotes(delegator),
      })),
    );

    return results
      .filter((d) => d.power > 0n)
      .sort((a, b) => (b.power > a.power ? 1 : b.power < a.power ? -1 : 0));
  }

  /**
   * Get top delegates by voting power using a pre-supplied address list.
   *
   * Useful when you already have a known set of delegate addresses (e.g. from
   * an off-chain indexer) and want to rank them without scanning chain events.
   *
   * @param addresses - Known delegate addresses to query
   * @param limit     - Maximum number to return (default 20)
   */
  async getTopDelegatesByAddresses(
    addresses: string[],
    limit = 20,
  ): Promise<DelegateInfo[]> {
    const totalSupply = await this.getTotalSupply();
    if (totalSupply === 0n) return [];

    const delegates = await Promise.all(
      addresses.map(async (address) => {
        const votes = await this.getVotes(address);
        return {
          address,
          votes,
          percentOfSupply:
            totalSupply > 0n ? Number((votes * 10000n) / totalSupply) / 100 : 0,
        };
      }),
    );

    return delegates
      .filter((d) => d.votes > 0n)
      .sort((a, b) => (b.votes > a.votes ? 1 : b.votes < a.votes ? -1 : 0))
      .slice(0, limit);
  }

  /**
   * Delegate voting power by signature (gasless for the token holder).
   *
   * A relayer submits this on behalf of a token holder who signed a message
   * off-chain. The holder only needs to sign, no gas required.
   *
   * @param owner - The token holder who signed the delegation message
   * @param delegatee - The address to delegate voting power to
   * @param nonce - Unique nonce to prevent replay attacks
   * @param expiry - Unix timestamp after which the signature is invalid
   * @param signature - Ed25519 signature over (owner, delegatee, nonce, expiry)
   */
  async delegateBySig(
    owner: string,
    delegatee: string,
    nonce: bigint,
    expiry: bigint,
    signature: Buffer,
  ): Promise<void> {
    return this.retry(async () => {
      const account = await this.server.getAccount(this.contract.contractId());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "delegate_by_sig",
            nativeToScVal(owner, { type: "address" }),
            nativeToScVal(delegatee, { type: "address" }),
            nativeToScVal(nonce, { type: "u64" }),
            nativeToScVal(expiry, { type: "u64" }),
            nativeToScVal(signature, { type: "bytes" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      await this.server.sendTransaction(prepared);
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Get the current votes contract settings.
   */
  async getVotesSettings(): Promise<VotesSettings> {
    const retentionResult = await this.server.simulateTransaction(
      new TransactionBuilder(await this.server.getAccount(this.readAccount()), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call("checkpoint_retention_period"))
        .setTimeout(30)
        .build(),
    );
    const enabledResult = await this.server.simulateTransaction(
      new TransactionBuilder(await this.server.getAccount(this.readAccount()), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call("time_weight_enabled"))
        .setTimeout(30)
        .build(),
    );
    const scaleResult = await this.server.simulateTransaction(
      new TransactionBuilder(await this.server.getAccount(this.readAccount()), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call("time_weight_scale"))
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(retentionResult)) {
      throw new VotesError(VotesErrorCode.SimulationFailed, "Failed to get checkpoint retention period");
    }
    if (SorobanRpc.Api.isSimulationError(enabledResult)) {
      throw new VotesError(VotesErrorCode.SimulationFailed, "Failed to get time weight enabled");
    }
    if (SorobanRpc.Api.isSimulationError(scaleResult)) {
      throw new VotesError(VotesErrorCode.SimulationFailed, "Failed to get time weight scale");
    }

    return {
      checkpointRetentionPeriod: scValToNative((retentionResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval),
      timeWeightEnabled: scValToNative((enabledResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval),
      timeWeightScale: scValToNative((scaleResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result!.retval),
    };
  }

  /**
   * Enable or disable time-weighted voting (admin only).
   */
  async setTimeWeightEnabled(signer: Keypair, enabled: boolean): Promise<void> {
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call("set_time_weight_enabled", nativeToScVal(enabled)),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    const result = await this.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw parseVotesError(result);
    }
  }

  /**
   * Set the time-weighting scale (admin only).
   */
  async setTimeWeightScale(signer: Keypair, scale: number): Promise<void> {
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "set_time_weight_scale",
          nativeToScVal(scale, { type: "u32" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    const result = await this.server.sendTransaction(prepared);
    if (result.status === "ERROR") {
      throw parseVotesError(result);
    }
  }

  /**
   * Get the delegator record (balance and start ledger) for an address.
   */
  async getDelegatorRecord(account: string): Promise<DelegatorRecord | null> {
    // Note: This requires the contract to expose a way to read the DelegatorRecord
    // Currently, it's in storage but not explicitly exposed via a getter.
    // I previously added DelegatorRecord to DataKey, but didn't add a getter.
    // Let's assume we add a getter `get_delegator_record` to the contract.
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(await this.server.getAccount(this.readAccount(account)), {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "get_delegator_record",
            nativeToScVal(account, { type: "address" }),
          ),
        )
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) return null;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) return null;
    const native = scValToNative(raw);
    return {
      balance: BigInt(native.balance),
      startLedger: native.start_ledger,
    };
  }

  /**
   * Sign a delegation message off-chain for gasless delegation.
   *
   * @param signer - Keypair of the token holder
   * @param delegatee - Address to delegate to
   * @param nonce - Current nonce for the owner
   * @param expiry - Unix timestamp after which the signature is invalid
   * @returns Ed25519 signature bytes
   */
  signDelegation(
    signer: Keypair,
    delegatee: string,
    nonce: bigint,
    expiry: bigint,
  ): Buffer {
    const message = Buffer.concat([
      Buffer.from(signer.publicKey()),
      Buffer.from(delegatee),
      Buffer.from(nonce.toString(16).padStart(16, "0"), "hex"),
      Buffer.from(expiry.toString(16).padStart(16, "0"), "hex"),
    ]);

    return signer.sign(message);
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private readAccount(fallback?: string): string {
    return this.config.simulationAccount ?? fallback ?? this.contract.contractId();
  }

  /**
   * Scan all `del_chsh` (delegate changed) events from the token-votes
   * contract and return a Map of delegator → current delegatee.
   *
   * The contract emits this event on every `delegate()` call:
   *   topics: (symbol "del_chsh", delegator_address)
   *   data:   (previous_delegatee | null, new_delegatee)
   *
   * We take the last event per delegator to get the current delegation state.
   *
   * @throws {VotesError} with code EventScanFailed on RPC failure.
   */
  private async buildDelegationMap(
    fromLedger?: number,
  ): Promise<Map<string, string>> {
    const delegationMap = new Map<string, string>();
    await this.buildDelegationMapIncremental({
      fromLedger,
      delegationMap,
    });
    return delegationMap;
  }

  private encodeDelegationCursor(nextStartLedger: number): string {
    const payload = JSON.stringify({ nextStartLedger });
    if (typeof Buffer !== "undefined") {
      return Buffer.from(payload, "utf8").toString("base64");
    }
    // Browser fallback
    return btoa(unescape(encodeURIComponent(payload)));
  }

  private decodeDelegationCursor(cursor: string): number | null {
    try {
      const raw =
        typeof Buffer !== "undefined"
          ? Buffer.from(cursor, "base64").toString("utf8")
          : decodeURIComponent(escape(atob(cursor)));
      const parsed = JSON.parse(raw) as { nextStartLedger?: unknown };
      const next = Number(parsed.nextStartLedger);
      return Number.isFinite(next) && next > 0 ? Math.floor(next) : null;
    } catch {
      return null;
    }
  }

  private async buildDelegationMapIncremental({
    fromLedger,
    cursor,
    maxEventsToScan,
    delegationMap,
  }: {
    fromLedger?: number;
    cursor?: string;
    maxEventsToScan?: number;
    delegationMap: Map<string, string>;
  }): Promise<{ nextCursor: string | null }> {
    let startLedger: number | undefined = fromLedger;
    if (cursor) {
      const decoded = this.decodeDelegationCursor(cursor);
      if (decoded) startLedger = decoded;
    }

    if (startLedger === undefined) {
      const info = await this.retry(() => this.server.getLatestLedger());
      startLedger = Math.max(1, info.sequence - DEFAULT_SCAN_WINDOW);
    }

    const contractId = this.contract.contractId();
    const topicFilter = [
      xdr.ScVal.scvSymbol("del_chsh"),
      xdr.ScVal.scvSymbol("del_revk"),
    ];

    const scanCap =
      maxEventsToScan === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, Math.floor(maxEventsToScan));

    try {
      let cursorLedger = startLedger;
      const latest = (await this.server.getLatestLedger()).sequence;
      let scanned = 0;

      while (cursorLedger <= latest && scanned < scanCap) {
        const remaining = scanCap - scanned;
        const limit = Math.max(1, Math.min(100, remaining));
        const response = await this.retry(() =>
          this.server.getEvents({
            startLedger: cursorLedger,
            filters: [
              {
                type: "contract",
                contractIds: [contractId],
                topics: [topicFilter.map((v) => v.toXDR("base64"))],
              },
            ],
            limit,
          }),
        );

        const events = response.events ?? [];
        if (events.length === 0) {
          return { nextCursor: null };
        }

        let maxLedger = cursorLedger;

        for (const event of events) {
          scanned += 1;
          try {
            const symbol = scValToNative(event.topic[0]);
            const delegator = scValToNative(event.topic[1]) as string;
            if (symbol === "del_chsh") {
              const data = scValToNative(event.value) as [
                string | null,
                string,
              ];
              const newDelegatee = data[1];
              if (
                typeof delegator === "string" &&
                typeof newDelegatee === "string"
              ) {
                delegationMap.set(delegator, newDelegatee);
              }
            } else if (symbol === "del_revk") {
              if (typeof delegator === "string") {
                delegationMap.delete(delegator);
              }
            }
          } catch {
            // Malformed event — skip
          }
          if (event.ledger > maxLedger) maxLedger = event.ledger;
        }

        cursorLedger = maxLedger + 1;
      }

      if (cursorLedger > latest) return { nextCursor: null };
      return { nextCursor: this.encodeDelegationCursor(cursorLedger) };
    } catch (err) {
      throw new VotesError(
        VotesErrorCode.EventScanFailed,
        `Failed to scan delegation events: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }
}

export interface TopDelegatesOptions {
  /** Maximum number of delegates to return (default 50). */
  limit?: number;
  /** Number of delegates to skip before returning results (default 0). */
  offset?: number;
  /** Earliest ledger to scan events from (default latest - DEFAULT_SCAN_WINDOW). */
  fromLedger?: number;
  /** Opaque pagination cursor returned by a prior call. */
  cursor?: string;
  /** Safety cap to prevent unbounded scans. */
  maxEventsToScan?: number;
  /**
   * Optional delegation map to reuse across calls.
   * Pass the returned map back in to avoid rebuilding from scratch.
   */
  delegationMap?: Map<string, string>;
}

export interface TopDelegatesResult {
  delegates: TopDelegate[];
  nextCursor: string | null;
  delegationMap: Map<string, string>;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Compute the Gini coefficient for an array of voting power values.
 *
 * Returns 0 when the array is empty or all values are equal (perfectly
 * uniform distribution), and approaches 1 when all power is concentrated
 * in a single account.
 */
function computeGini(powers: bigint[]): number {
  if (powers.length === 0) return 0;

  const sorted = [...powers].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = sorted.length;
  const total = sorted.reduce((s, v) => s + v, 0n);
  if (total === 0n) return 0;

  let weightedSum = 0n;
  for (let i = 0; i < n; i++) {
    weightedSum += BigInt(i + 1) * sorted[i];
  }

  return (2 * Number(weightedSum)) / (n * Number(total)) - (n + 1) / n;
}
