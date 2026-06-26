import type { GovernorConfig, Network } from "@nebgov/sdk";

/** Governor client config from Next public env (or null if misconfigured). */
export function readGovernorConfig(): GovernorConfig | null {
  const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
  const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
  const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
  const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

  if (!governorAddress || !timelockAddress || !votesAddress) return null;

  return {
    governorAddress,
    timelockAddress,
    votesAddress,
    network,
    ...(rpcUrl ? { rpcUrl } : {}),
  };
}

export function subscriptionOptsFromConfig(config: GovernorConfig): {
  network: Network;
  rpcUrl?: string;
} {
  return { network: config.network, ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}) };
}

/** Returns the indexer base URL or null if not configured. */
export function readIndexerUrl(): string | null {
  return process.env.NEXT_PUBLIC_INDEXER_URL ?? null;
}
