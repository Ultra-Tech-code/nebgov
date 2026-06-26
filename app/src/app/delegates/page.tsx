"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { VotesClient, type TopDelegate, type Network } from "@nebgov/sdk";
import { useWallet } from "../../lib/wallet-context";
import { DelegateModal } from "../../components/DelegateModal";
import { Skeleton } from "../../components/ui/Skeleton";

function DelegateSkeleton() {
  return (
    <tr>
      <td className="py-4 px-4">
        <Skeleton className="h-4 w-6" />
      </td>
      <td className="py-4 px-4">
        <Skeleton className="h-4 w-32" />
      </td>
      <td className="py-4 px-4">
        <Skeleton className="h-4 w-20" />
      </td>
      <td className="py-4 px-4">
        <Skeleton className="h-4 w-12" />
      </td>
      <td className="py-4 px-4">
        <Skeleton className="h-2 w-full" />
      </td>
      <td className="py-4 px-4">
        <Skeleton className="h-8 w-20" />
      </td>
    </tr>
  );
}

function formatAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function formatVotes(votes: bigint): string {
  const num = Number(votes) / 1e7;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(2)}K`;
  return num.toLocaleString();
}

const PAGE_SIZE = 20;

export default function DelegatesPage() {
  const [delegates, setDelegates] = useState<TopDelegate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalDelegated, setTotalDelegated] = useState(0n);
  const [totalSupply, setTotalSupply] = useState(0n);
  const [modalOpen, setModalOpen] = useState(false);
  const [prefillAddress, setPrefillAddress] = useState<string>("");
  const [currentDelegatee, setCurrentDelegatee] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [client, setClient] = useState<VotesClient | null>(null);
  const { publicKey } = useWallet();

  useEffect(() => {
    async function fetchDelegates() {
      try {
        const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
        const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
        const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
        const network = (process.env.NEXT_PUBLIC_NETWORK ||
          "testnet") as Network;
        const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

        if (!governorAddress || !timelockAddress || !votesAddress) {
          throw new Error("Missing required environment variables.");
        }

        const votesClient = new VotesClient({
          governorAddress,
          timelockAddress,
          votesAddress,
          network,
          ...(rpcUrl && { rpcUrl }),
        });
        setClient(votesClient);

        const supply = await votesClient.getTotalSupply();
        setTotalSupply(supply);

        const result = await votesClient.getTopDelegates({ limit: PAGE_SIZE, offset: 0 });
        const page = Array.isArray(result) ? result : result.delegates;
        setDelegates(page);
        const total = page.reduce((sum, d) => sum + d.votingPower, 0n);
        setTotalDelegated(total);
        setOffset(PAGE_SIZE);
        setHasMore(page.length === PAGE_SIZE);

        if (publicKey) {
          setCurrentDelegatee(await votesClient.getDelegatee(publicKey));
        } else {
          setCurrentDelegatee(null);
        }
      } catch (err) {
        console.error("Error fetching delegates:", err);
        setError(
          err instanceof Error ? err.message : "Failed to load delegates",
        );
      } finally {
        setLoading(false);
      }
    }

    fetchDelegates();
  }, [publicKey]);

  async function loadMore() {
    if (!client || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await client.getTopDelegates({ limit: PAGE_SIZE, offset });
      const page = Array.isArray(result) ? result : result.delegates;
      setDelegates((prev) => [...prev, ...page]);
      setOffset((prev) => prev + PAGE_SIZE);
      setHasMore(page.length === PAGE_SIZE);
    } catch (err) {
      console.error("Error loading more delegates:", err);
    } finally {
      setLoadingMore(false);
    }
  }

  function handleDelegateClick(address: string) {
    setPrefillAddress(address);
    setModalOpen(true);
  }

  const delegatedPercent =
    totalSupply > 0n
      ? Number((totalDelegated * 10000n) / totalSupply) / 100
      : 0;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Delegates</h1>
          <p className="text-gray-500 mt-1">
            Top voting power holders in the protocol.
          </p>
        </div>
        <button
          onClick={() => {
            setPrefillAddress("");
            setModalOpen(true);
          }}
          className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors"
        >
          Delegate
        </button>
      </div>

      {totalSupply > 0n && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 mb-6">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm text-gray-600">Total Delegated</span>
            <span className="text-sm font-medium text-gray-900">
              {formatVotes(totalDelegated)} / {formatVotes(totalSupply)} (
              {delegatedPercent.toFixed(1)}%)
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-indigo-600 h-2 rounded-full transition-all"
              style={{ width: `${Math.min(delegatedPercent, 100)}%` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
          <p className="text-red-800 text-sm font-medium">
            Error loading delegates
          </p>
          <p className="text-red-600 text-sm mt-1">{error}</p>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="py-3 px-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                #
              </th>
              <th className="py-3 px-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Delegate
              </th>
              <th className="py-3 px-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Votes
              </th>
              <th className="py-3 px-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Delegators
              </th>
              <th className="py-3 px-4 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                % of Supply
              </th>
              <th className="py-3 px-4 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Action
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {loading && (
              <>
                <DelegateSkeleton />
                <DelegateSkeleton />
                <DelegateSkeleton />
              </>
            )}

            {!loading && delegates.length === 0 && !error && (
              <tr>
                <td colSpan={6} className="py-12 text-center text-gray-500">
                  No delegates found. Be the first to delegate!
                </td>
              </tr>
            )}

            {!loading &&
              delegates.map((delegate, index) => {
                const isCurrentUser = publicKey === delegate.address;
                const percentOfSupply =
                  totalSupply > 0n
                    ? Number((delegate.votingPower * 10000n) / totalSupply) /
                      100
                    : 0;
                return (
                  <tr
                    key={delegate.address}
                    className={
                      isCurrentUser ? "bg-indigo-50" : "hover:bg-gray-50"
                    }
                  >
                    <td className="py-4 px-4 text-sm text-gray-500">
                      {index + 1}
                    </td>
                    <td className="py-4 px-4">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/profile/${delegate.address}`}
                          className="font-mono text-sm text-indigo-600 hover:text-indigo-800 hover:underline"
                        >
                          {formatAddress(delegate.address)}
                        </Link>
                        {isCurrentUser && (
                          <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded">
                            You
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-4 px-4 text-sm font-medium text-gray-900">
                      {formatVotes(delegate.votingPower)}
                    </td>
                    <td className="py-4 px-4 text-sm text-gray-600">
                      {delegate.delegatorCount.toLocaleString()}
                    </td>
                    <td className="py-4 px-4">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-gray-200 rounded-full h-2 max-w-[100px]">
                          <div
                            className="bg-indigo-600 h-2 rounded-full"
                            style={{
                              width: `${Math.min(percentOfSupply * 2, 100)}%`,
                            }}
                          />
                        </div>
                        <span className="text-sm text-gray-500">
                          {percentOfSupply.toFixed(1)}%
                        </span>
                      </div>
                    </td>
                    <td className="py-4 px-4 text-right">
                      <button
                        onClick={() => handleDelegateClick(delegate.address)}
                        className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
                      >
                        Delegate
                      </button>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="mt-6 text-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loadingMore ? "Loading..." : "Load More"}
          </button>
        </div>
      )}

      <p className="mt-4 text-xs text-gray-400 text-center">
        Estimated data — depends on network conditions
      </p>

      <DelegateModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onDelegated={() => window.location.reload()}
        prefillAddress={prefillAddress}
        currentDelegatee={currentDelegatee}
      />
    </div>
  );
}
