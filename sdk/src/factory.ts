import { Contract, Keypair, SorobanRpc, TransactionBuilder, Networks, BASE_FEE, nativeToScVal, scValToNative } from "@stellar/stellar-sdk";
import { DeploySettings, GovernorEntry, FactoryConfig, Network, VoteType } from "./types";

export type { GovernorEntry, DeploySettings } from "./types";

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

export class FactoryClient {
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;

  constructor(config: FactoryConfig) {
    const rpcUrl = config.rpcUrl ?? RPC_URLS[config.network];
    this.server = new SorobanRpc.Server(rpcUrl, { allowHttp: false });
    this.contract = new Contract(config.factoryAddress);
    this.networkPassphrase = NETWORK_PASSPHRASES[config.network];
  }

  async getGovernorCount(): Promise<bigint> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.contract.contractId()),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
      )
        .addOperation(this.contract.call("governor_count"))
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) return 0n;
    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    return raw ? BigInt(scValToNative(raw)) : 0n;
  }

  async estimateDeployCost(): Promise<bigint> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.contract.contractId()),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
      )
        .addOperation(this.contract.call("estimate_deploy_cost"))
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error("Simulation error estimating deploy cost");
    }

    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) {
      throw new Error("No return value when estimating deploy cost");
    }

    return BigInt(scValToNative(raw));
  }

  async getGovernor(id: bigint): Promise<GovernorEntry> {
    const result = await this.server.simulateTransaction(
      new TransactionBuilder(
        await this.server.getAccount(this.contract.contractId()),
        { fee: BASE_FEE, networkPassphrase: this.networkPassphrase },
      )
        .addOperation(
          this.contract.call("get_governor", nativeToScVal(id, { type: "u64" })),
        )
        .setTimeout(30)
        .build(),
    );

    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(`Simulation error fetching governor ${id}`);
    }

    const raw = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse)
      .result?.retval;
    if (!raw) {
      throw new Error(`No return value when fetching governor ${id}`);
    }

    return scValToNative(raw) as GovernorEntry;
  }

  async getAllGovernors(opts?: {
    limit?: number;
    offset?: number;
  }): Promise<GovernorEntry[]> {
    const count = await this.getGovernorCount();
    if (count === 0n) return [];

    const offset = opts?.offset != null && opts.offset > 0 ? BigInt(opts.offset) : 0n;
    if (offset >= count) return [];

    const limit = opts?.limit != null && opts.limit > 0 ? BigInt(opts.limit) : count - offset;
    const end = offset + limit;
    const maxId = count < end ? count : end;

    const entries: GovernorEntry[] = [];
    const pageSize = 50n;

    for (let start = offset + 1n; start <= maxId; start += pageSize) {
      const pageEnd = start + pageSize - 1n;
      const batchEnd = pageEnd < maxId ? pageEnd : maxId;
      const page = await Promise.all(
        Array.from({ length: Number(batchEnd - start + 1n) }, (_, index) => {
          const id = start + BigInt(index);
          return this.getGovernor(id);
        }),
      );
      entries.push(...page);
    }

    return entries;
  }

  /**
   * Deploy a new governor registry entry using the factory contract.
   * Returns the newly assigned governor ID.
   */
  async deploy(signer: Keypair, token: string, settings: DeploySettings): Promise<bigint> {
    const account = await this.server.getAccount(signer.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          "deploy",
          nativeToScVal(signer.publicKey(), { type: "address" }),
          nativeToScVal(token, { type: "address" }),
          nativeToScVal(settings.votingDelay, { type: "u32" }),
          nativeToScVal(settings.votingPeriod, { type: "u32" }),
          nativeToScVal(settings.quorumNumerator, { type: "u32" }),
          nativeToScVal(settings.proposalThreshold, { type: "i128" }),
          nativeToScVal(settings.timelockDelay, { type: "u64" }),
          nativeToScVal(settings.guardian, { type: "address" }),
          nativeToScVal(this.voteTypeToUint(settings.voteType), { type: "u32" }),
          nativeToScVal(settings.proposalGracePeriod, { type: "u32" }),
        ),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.server.prepareTransaction(tx);
    prepared.sign(signer);
    const result = await this.server.sendTransaction(prepared);
    if ((result as any).status === "ERROR") {
      throw new Error("Deploy transaction failed");
    }

    const confirmed = await this.pollForConfirmation((result as any).hash);
    const raw = confirmed.returnValue;
    if (!raw) {
      throw new Error("No return value from confirmed deploy transaction");
    }

    return BigInt(scValToNative(raw));
  }

  private async pollForConfirmation(
    hash: string,
    retries = 10,
    delayMs = 2000,
  ): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
    for (let i = 0; i < retries; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
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

  private voteTypeToUint(voteType: VoteType): number {
    switch (voteType) {
      case VoteType.Simple:
        return 0;
      case VoteType.Extended:
        return 1;
      case VoteType.Quadratic:
        return 2;
      default:
        return 1;
    }
  }
}
