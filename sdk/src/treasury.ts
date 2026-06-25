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
  TreasuryConfig,
  TreasuryTx,
  BatchTransferRecipient,
  BatchTransferEvent,
  Network,
  SpendingCap,
} from "./types";
import { TreasuryError, TreasuryErrorCode, parseTreasuryError } from "./errors";
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
 * Encode a {@link BatchTransferRecipient} as an XDR ScVal map matching the
 * on-chain `BatchRecipient` struct (field order is alphabetical per XDR spec).
 */
function encodeBatchRecipient(r: BatchTransferRecipient): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("amount"),
      val: nativeToScVal(r.amount, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("recipient"),
      val: nativeToScVal(r.address, { type: "address" }),
    }),
  ]);
}

/**
 * TreasuryClient — interact with a deployed NebGov treasury contract.
 *
 * The treasury holds protocol funds and disburses them via governor-approved
 * proposals. `batchTransfer` enables gas-efficient multi-recipient payouts
 * in a single transaction.
 *
 * @example
 * const client = new TreasuryClient({
 *   treasuryAddress: "CABC...",
 *   network: "testnet",
 * });
 *
 * const opHash = await client.batchTransfer(signer, tokenAddress, [
 *   { address: "GABC...", amount: 1_000_000n },
 *   { address: "GDEF...", amount: 2_000_000n },
 * ]);
 */
export class TreasuryClient {
  private readonly config: TreasuryConfig;
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(config: TreasuryConfig) {
    this.config = config;
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.treasuryAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  private readAccount(fallback?: string): string {
    const account = this.config.simulationAccount ?? fallback;
    if (!account) {
      throw new TreasuryError(
        TreasuryErrorCode.InvalidArguments,
        "TreasuryClient read methods require simulationAccount in TreasuryConfig",
      );
    }
    return account;
  }

  private async retry<T>(
    fn: () => Promise<T>,
    filter?: (e: unknown) => boolean,
  ): Promise<T> {
    return withRetry(fn, {
      maxAttempts: this.config.maxAttempts ?? 3,
      baseDelayMs: this.config.baseDelayMs ?? 1000,
      retryOn: filter ?? isNetworkError,
    });
  }

  private isRetryableSubmissionError(e: unknown): boolean {
    if (isNetworkError(e)) return true;
    if (e instanceof TreasuryError) {
      // Don't retry on contract logic errors (codes < 100)
      return (
        e.code >= 100 &&
        e.code !== TreasuryErrorCode.TransactionFailed &&
        e.code !== TreasuryErrorCode.MissingReturnValue
      );
    }
    const msg = String(e);
    if (msg.includes("TransactionAlreadyInMempool")) return false;
    return false;
  }

  /**
   * Disburse tokens to multiple recipients in a single transaction.
   *
   * Validation (all amounts positive, non-empty list) is enforced on-chain
   * before any transfer takes place — the operation is all-or-nothing.
   *
   * Only the governor may call this method.
   *
   * @param signer     - Keypair authorising the call (must be the governor signer)
   * @param token      - Strkey address of the SEP-41 token to transfer
   * @param recipients - List of recipient addresses and amounts
   * @returns Hex-encoded SHA-256 operation hash for tracking
   */
  async batchTransfer(
    signer: Keypair,
    token: string,
    recipients: BatchTransferRecipient[],
  ): Promise<string> {
    return this.retry(async () => {
      if (recipients.length === 0) {
        throw new TreasuryError(
          TreasuryErrorCode.InvalidArguments,
          "recipients list must not be empty",
        );
      }

      for (const r of recipients) {
        if (r.amount <= 0n) {
          throw new TreasuryError(
            TreasuryErrorCode.InvalidArguments,
            `amount must be positive, got ${r.amount} for ${r.address}`,
          );
        }
      }

      const account = await this.server.getAccount(signer.publicKey());

      const recipientsScVal = xdr.ScVal.scvVec(
        recipients.map(encodeBatchRecipient),
      );

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "batch_transfer",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(token, { type: "address" }),
            recipientsScVal,
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);

      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseTreasuryError(result);
      }

      const confirmed = await this.pollForConfirmation(result.hash);
      const returnVal = confirmed.returnValue;
      if (!returnVal) {
        throw new TreasuryError(
          TreasuryErrorCode.MissingReturnValue,
          "No return value from batch_transfer",
        );
      }

      const bytes = scValToNative(returnVal) as Uint8Array;
      return Buffer.from(bytes).toString("hex");
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Configure a per-token spending cap for batch transfers.
   */
  async setSpendingCap(
    signer: Keypair,
    token: string,
    maxAmount: bigint,
    periodLedgers: number,
  ): Promise<void> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "set_spending_cap",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(token, { type: "address" }),
            nativeToScVal(maxAmount, { type: "i128" }),
            nativeToScVal(periodLedgers, { type: "u32" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);
      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseTreasuryError(result);
      }
    }, (e) => this.isRetryableSubmissionError(e));
  }

  /**
   * Fetch the configured spending cap for a token, if any.
   */
  async getSpendingCap(token: string): Promise<SpendingCap | null> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "get_spending_cap",
              nativeToScVal(token, { type: "address" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return null;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) return null;
      const cap = scValToNative(raw) as
        | { token: string; max_amount: bigint | number | string; period_ledgers: bigint | number | string }
        | null;
      if (!cap) return null;
      return {
        token: cap.token,
        maxAmount: BigInt(cap.max_amount),
        periodLedgers: Number(cap.period_ledgers),
      };
    });
  }

  /**
   * Get the amount spent during the current spending period for a token.
   */
  async getSpentThisPeriod(token: string): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "get_spent_this_period",
              nativeToScVal(token, { type: "address" }),
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
   * Get the remaining spending budget for a token in the current period.
   *
   * Returns the difference between the spending cap's maxAmount and what has
   * been spent so far in the current period. If no cap is set, returns null.
   * If spending has exceeded the cap, returns 0n.
   *
   * @param token - Strkey address of the token to check
   * @returns Remaining budget in the current period, or null if no cap is set
   */
  async getSpendingRemaining(token: string): Promise<bigint | null> {
    return this.retry(async () => {
      const cap = await this.getSpendingCap(token);
      if (!cap) return null;

      const spent = await this.getSpentThisPeriod(token);
      const remaining = cap.maxAmount - spent;
      return remaining > 0n ? remaining : 0n;
    });
  }

  /**
   * Get current treasury owner addresses from on-chain state.
   */
  async getOwners(): Promise<string[]> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(this.contract.call("owners"))
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return [];
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) return [];
      const owners = scValToNative(raw) as unknown[];
      return owners.map((owner) => String(owner));
    });
  }

  /**
   * Get treasury approval threshold from on-chain state.
   */
  async getThreshold(): Promise<number> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(this.contract.call("threshold"))
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return 1;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) return 1;
      return Number(scValToNative(raw));
    });
  }

  /**
   * Check whether an address is currently a treasury owner.
   */
  async isOwner(address: string): Promise<boolean> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call(
              "is_treasury_owner",
              nativeToScVal(address, { type: "address" }),
            ),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return false;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) return false;
      return Boolean(scValToNative(raw));
    });
  }

  /**
   * Get total number of treasury transactions.
   */
  async getTxCount(): Promise<bigint> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(this.contract.call("tx_count"))
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) return 0n;
      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) return 0n;
      return BigInt(scValToNative(raw) as number | bigint | string);
    });
  }

  /**
   * Get a treasury transaction by ID.
   */
  async getTx(txId: bigint): Promise<TreasuryTx> {
    return this.retry(async () => {
      const result = await this.server.simulateTransaction(
        new TransactionBuilder(
          await this.server.getAccount(this.readAccount()),
          { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
        )
          .addOperation(
            this.contract.call("get_tx", nativeToScVal(txId, { type: "u64" })),
          )
          .setTimeout(30)
          .build(),
      );

      if (SorobanRpc.Api.isSimulationError(result)) {
        throw new TreasuryError(
          TreasuryErrorCode.InvalidArguments,
          `Treasury transaction ${txId} not found`,
        );
      }

      const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
        .result?.retval;
      if (!raw) {
        throw new TreasuryError(
          TreasuryErrorCode.MissingReturnValue,
          `No return value from get_tx(${txId})`,
        );
      }

      const tx = scValToNative(raw) as {
        id: bigint | number | string;
        proposer: string;
        target: string;
        approvals: number | bigint | string;
        executed: boolean;
        cancelled: boolean;
      };

      return {
        id: BigInt(tx.id),
        proposer: tx.proposer,
        target: tx.target,
        approvals: Number(tx.approvals),
        executed: Boolean(tx.executed),
        cancelled: Boolean(tx.cancelled),
      };
    });
  }

  /**
   * Submit a proposal for approval with spending limit enforcement.
   *
   * Validates the proposed transfer amount against per-transfer and daily
   * spending limits before allowing the proposal to be created. If either
   * limit is exceeded on-chain, the transaction is rejected with the
   * corresponding error variant.
   *
   * The daily limit operates on a rolling 24-hour window using Unix timestamps.
   * If the window has elapsed since the last submission, the daily accumulator
   * automatically resets.
   *
   * @param signer        - Keypair authorising the proposal (must be an owner)
   * @param target        - Contract address to call when the proposal is executed
   * @param calldata      - Encoded function call to invoke on the target
   * @param amount        - Transfer amount to validate against spending limits
   * @returns The proposal ID on success
   *
   * @throws TreasuryError with code `SingleTransferExceeded` if amount exceeds max allowed per transfer
   * @throws TreasuryError with code `DailyLimitExceeded` if accumulated amount exceeds daily limit
   */
  async submitWithLimit(
    signer: Keypair,
    target: string,
    calldata: Buffer | Uint8Array,
    amount: bigint,
  ): Promise<bigint> {
    return this.retry(async () => {
      const account = await this.server.getAccount(signer.publicKey());

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            "submit_with_limit",
            nativeToScVal(signer.publicKey(), { type: "address" }),
            nativeToScVal(target, { type: "address" }),
            nativeToScVal(calldata, { type: "bytes" }),
            nativeToScVal(amount, { type: "i128" }),
          ),
        )
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(tx);
      prepared.sign(signer);

      const result = await this.server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw parseTreasuryError(result);
      }

      const confirmed = await this.pollForConfirmation(result.hash);
      const returnVal = confirmed.returnValue;
      if (!returnVal) {
        throw new TreasuryError(
          TreasuryErrorCode.MissingReturnValue,
          "No return value from submit_with_limit",
        );
      }

      return scValToNative(returnVal) as bigint;
    }, (e) => this.isRetryableSubmissionError(e));
  }

  // --- Internal ---

  /**
   * Query the indexer for paginated treasury batch transfer history.
   *
   * Requires `config.indexerUrl` to be set. Returns transfers in descending
   * ledger order (most recent first).
   *
   * @param fromLedger - Optional minimum ledger to filter results (inclusive)
   * @param limit      - Maximum number of records to return (default 20, max 100)
   * @param offset     - Pagination offset (default 0)
   */
  async getBatchTransferHistory(
    fromLedger?: number,
    limit = 20,
    offset = 0,
  ): Promise<BatchTransferEvent[]> {
    if (!this.config.indexerUrl) {
      throw new TreasuryError(
        TreasuryErrorCode.InvalidArguments,
        "indexerUrl must be set in TreasuryConfig to use getBatchTransferHistory",
      );
    }

    const params = new URLSearchParams({
      limit: String(Math.min(limit, 100)),
      offset: String(offset),
    });

    const url = `${this.config.indexerUrl.replace(/\/$/, "")}/treasury/transfers?${params}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new TreasuryError(
        TreasuryErrorCode.TransactionFailed,
        `Indexer request failed: ${response.status} ${response.statusText}`,
      );
    }

    const json = (await response.json()) as {
      data: Array<{
        op_hash: string;
        token: string;
        recipient_count: number;
        total_amount: string;
        ledger: number;
      }>;
    };

    const events: BatchTransferEvent[] = json.data
      .map((row) => ({
        opHash: row.op_hash,
        token: row.token,
        recipientCount: row.recipient_count,
        totalAmount: BigInt(row.total_amount),
        ledger: row.ledger,
      }))
      .filter((e) => fromLedger === undefined || e.ledger >= fromLedger);

    return events;
  }

  // --- Private helpers ---

  private async pollForConfirmation(
    hash: string,
    retries = 10,
    delayMs = 2000,
  ): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
    for (let i = 0; i < retries; i++) {
      await new Promise((r) => setTimeout(r, delayMs));
      const status = await this.retry(() => this.server.getTransaction(hash));
      if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        return status as SorobanRpc.Api.GetSuccessfulTransactionResponse;
      }
      if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        throw new TreasuryError(
          TreasuryErrorCode.TransactionFailed,
          `Transaction failed: ${hash}`,
        );
      }
    }
    throw new TreasuryError(
      TreasuryErrorCode.TransactionTimeout,
      `Transaction not confirmed after ${retries} retries`,
    );
  }
}
