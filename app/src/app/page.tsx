"use client";

/**
 * Proposals list page — the main landing page.
 */

import { useState, useEffect, useMemo, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { GovernorClient, VotesClient, ProposalState, Network } from "@nebgov/sdk";
import { ErrorState } from "../components/ErrorState";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ProposalCardSkeleton } from "../components/ui/ProposalCardSkeleton";
import { useDebounce } from "../hooks/useDebounce";
import { getErrorMessage, reportFrontendError } from "../lib/frontend-error";
import { ProposalStateBadge } from "../components/ProposalStateBadge";
import { CountdownTimer } from "../components/CountdownTimer";


interface ProposalSummary {
  id: bigint;
  description: string;
  state: ProposalState;
  votesFor: bigint;
  votesAgainst: bigint;
  startLedger: number;
  endLedger: number;
}

const STATE_COLORS: Record<ProposalState, string> = {
  [ProposalState.Pending]: "bg-yellow-100 text-yellow-800",
  [ProposalState.Active]: "bg-blue-100 text-blue-800",
  [ProposalState.Succeeded]: "bg-green-100 text-green-800",
  [ProposalState.Defeated]: "bg-red-100 text-red-800",
  [ProposalState.Queued]: "bg-purple-100 text-purple-800",
  [ProposalState.Executed]: "bg-gray-100 text-gray-800",
  [ProposalState.Cancelled]: "bg-gray-100 text-gray-500",
  [ProposalState.Expired]: "bg-orange-100 text-orange-700",
};

const FILTER_STATES = [
  ProposalState.Active,
  ProposalState.Pending,
  ProposalState.Succeeded,
  ProposalState.Defeated,
  ProposalState.Queued,
  ProposalState.Executed,
];

type SortOption = "newest" | "oldest" | "most-votes" | "least-votes";


const PROPOSALS_PER_PAGE = 10;

function ProposalsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const search = searchParams.get("q") ?? "";
  const stateFilter = (searchParams.get("state") ?? "all") as
    | ProposalState
    | "all";
  const sort = (searchParams.get("sort") ?? "newest") as SortOption;

  const [proposals, setProposals] = useState<ProposalSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<number | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [totalSupply, setTotalSupply] = useState(0n);

  const [searchValue, setSearchValue] = useState(search);
  const debouncedSearch = useDebounce(searchValue, 300);

  useEffect(() => {
    setSearchValue(search);
  }, [search]);

  useEffect(() => {
    if (debouncedSearch !== search) {
      setParam("q", debouncedSearch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  function setParam(key: string, value: string, defaultVal = "") {
    const q = new URLSearchParams(searchParams.toString());
    if (value && value !== defaultVal) {
      q.set(key, value);
    } else {
      q.delete(key);
    }
    const queryString = q.toString();
    const currentQueryString = searchParams.toString();
    if (queryString !== currentQueryString) {
      router.push(`?${queryString}`);
    }
  }


  const filtered = useMemo(() => {
    let result = proposals;
    if (stateFilter !== "all") {
      result = result.filter((p) => p.state === stateFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((p) => p.description.toLowerCase().includes(q));
    }
    const sorted = [...result];
    if (sort === "newest") {
      sorted.sort((a, b) => (b.id > a.id ? 1 : b.id < a.id ? -1 : 0));
    } else if (sort === "oldest") {
      sorted.sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0));
    } else if (sort === "most-votes") {
      sorted.sort(
        (a, b) =>
          Number(b.votesFor + b.votesAgainst) -
          Number(a.votesFor + a.votesAgainst),
      );
    } else if (sort === "least-votes") {
      sorted.sort(
        (a, b) =>
          Number(a.votesFor + a.votesAgainst) -
          Number(b.votesFor + b.votesAgainst),
      );
    }

    return sorted;
  }, [proposals, stateFilter, search, sort]);

  const fetchProposals = async (cursor?: number, append = false) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const governorAddress = process.env.NEXT_PUBLIC_GOVERNOR_ADDRESS;
      const timelockAddress = process.env.NEXT_PUBLIC_TIMELOCK_ADDRESS;
      const votesAddress = process.env.NEXT_PUBLIC_VOTES_ADDRESS;
      const network = (process.env.NEXT_PUBLIC_NETWORK || "testnet") as Network;
      const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;
      const indexerUrl = process.env.NEXT_PUBLIC_INDEXER_URL;

      if (!governorAddress || !timelockAddress || !votesAddress) {
        throw new Error(
          "Missing required environment variables. Please check .env.local configuration.",
        );
      }

      if (indexerUrl) {
        try {
          const url = new URL(`${indexerUrl}/proposals`);
          url.searchParams.set("limit", PROPOSALS_PER_PAGE.toString());
          if (cursor) url.searchParams.set("before", cursor.toString());

          const response = await fetch(url.toString());
          if (response.ok) {
            const data = await response.json();
            const mapped = (data.proposals ?? []).map((p: any) => ({
              ...p,
              votesAbstain: BigInt(p.votesAbstain ?? 0),
              votesFor: BigInt(p.votesFor ?? 0),
              votesAgainst: BigInt(p.votesAgainst ?? 0),
              id: BigInt(p.id),
            }));
            if (append) {
              setProposals((prev) => [...prev, ...mapped]);
            } else {
              setProposals(mapped);
            }
            setNextCursor(data.nextCursor);
            setHasMore(data.hasMore || false);
            return;
          }
        } catch (indexerError) {
          console.warn(
            "Indexer failed, falling back to on-chain queries:",
            indexerError,
          );
        }
      }

      const client = new GovernorClient({
        governorAddress,
        timelockAddress,
        votesAddress,
        network,
        ...(rpcUrl && { rpcUrl }),
      });

      if (!append) {
        const votesClient = new VotesClient({
          governorAddress,
          timelockAddress,
          votesAddress,
          network,
          ...(rpcUrl && { rpcUrl }),
        });
        votesClient.getTotalSupply().then(setTotalSupply).catch(() => {});
      }

      const count = await client.proposalCount();
      if (count === 0n) {
        setProposals([]);
        setHasMore(false);
        return;
      }

      const currentPage = cursor
        ? Math.floor((Number(count) - cursor) / PROPOSALS_PER_PAGE) + 1
        : 1;
      const startIdx = Number(count) - (currentPage - 1) * PROPOSALS_PER_PAGE;
      const endIdx = Math.max(startIdx - PROPOSALS_PER_PAGE, 0);

      // Build ID list in reverse order (newest first) then batch-fetch
      const ids: bigint[] = [];
      for (let i = startIdx; i > endIdx && i > 0; i--) {
        ids.push(BigInt(i));
      }

      const batchResults = await client.getProposalsSummaryBatch(ids);
      const validProposals: ProposalSummary[] = batchResults
        .filter((r) => r.state !== undefined && r.votes !== undefined)
        .map((r) => ({
          id: r.id,
          description: `Proposal ${r.id}`,
          state: r.state!,
          votesFor: r.votes!.votesFor,
          votesAgainst: r.votes!.votesAgainst,
          startLedger: 0,
          endLedger: 0,
        }));

      if (append) {
        setProposals((prev) => [...prev, ...validProposals]);
      } else {
        setProposals(validProposals);
      }

      if (validProposals.length > 0) {
        setNextCursor(Number(validProposals[validProposals.length - 1].id));
        setHasMore(endIdx > 0);
      } else {
        setHasMore(false);
      }
    } catch (err) {
      reportFrontendError("proposals_page_load", err, {
        append,
        cursor,
        search,
        stateFilter,
        sort,
      });
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    fetchProposals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMore = () => {
    if (nextCursor && hasMore && !loadingMore) {
      fetchProposals(nextCursor, true);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Proposals</h1>
          <p className="text-gray-500 mt-1">
            Vote on governance decisions for this protocol.
          </p>
        </div>
        <Link
          href="/propose"
          className="bg-indigo-600 text-white px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors"
        >
          New Proposal
        </Link>
      </div>

      {/* Search + Sort */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <input
          type="search"
          placeholder="Search proposals…"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          aria-label="Search proposals"
        />
        <select
          value={sort}
          onChange={(e) => setParam("sort", e.target.value, "newest")}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
          aria-label="Sort proposals"
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="most-votes">Most Votes</option>
          <option value="least-votes">Least Votes</option>
        </select>

      </div>

      {/* Status filter tabs */}
      <div
        className="flex flex-wrap gap-2 mb-6"
        role="group"
        aria-label="Filter by status"
      >
        <button
          onClick={() => setParam("state", "all", "all")}
          className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
            stateFilter === "all"
              ? "bg-indigo-600 text-white border-indigo-600"
              : "bg-white text-gray-600 border-gray-300 hover:border-indigo-400"
          }`}
        >
          All
        </button>
        {FILTER_STATES.map((s) => (
          <button
            key={s}
            onClick={() => setParam("state", s, "all")}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              stateFilter === s
                ? "bg-indigo-600 text-white border-indigo-600"
                : "bg-white text-gray-600 border-gray-300 hover:border-indigo-400"
            }`}
          >
            {s}
          </button>
        ))}

      </div>

      {/* Error */}
      {error && (
        <ErrorState
          title="Error loading proposals"
          message={error}
          onRetry={() => fetchProposals()}
          className="mb-6"
        />
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-4">
          {Array.from({ length: 10 }).map((_, i) => (
            <ProposalCardSkeleton key={i} />
          ))}
        </div>
      )}

      {/* Empty — no proposals at all */}
      {!loading && !error && proposals.length === 0 && (
        <div className="text-center py-16">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
            />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">
            No proposals
          </h3>
          <p className="mt-1 text-sm text-gray-500">
            Get started by creating a new proposal.
          </p>
          <div className="mt-6">
            <Link
              href="/propose"
              className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
            >
              New Proposal
            </Link>
          </div>
        </div>
      )}

      {/* Empty — filters produced no results */}
      {!loading && !error && proposals.length > 0 && filtered.length === 0 && (
        <div className="text-center py-12">
          <p className="text-gray-500 text-sm">
            No proposals match your filters
          </p>
          <button
            onClick={() => router.push("?")}
            className="mt-3 text-indigo-600 text-sm hover:underline font-medium"
          >
            Reset filters
          </button>
        </div>
      )}


      {/* Proposals list */}
      {!loading && !error && filtered.length > 0 && (
        <>
          <div className="space-y-4">
            {filtered.map((p) => {
              const totalVotes = p.votesFor + p.votesAgainst + p.votesAbstain;
              const participationPct =
                totalSupply > 0n
                  ? Number((totalVotes * 10000n) / totalSupply) / 100
                  : null;
              return (
                <Link
                  key={p.id.toString()}
                  href={`/proposal/${p.id}`}
                  className="block bg-white border border-gray-200 rounded-xl p-6 hover:border-indigo-300 hover:shadow-sm transition-all"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-400 mb-1">
                        Proposal #{p.id.toString()}
                      </p>
                      <h2 className="text-lg font-semibold text-gray-900 truncate">
                        {p.description}
                      </h2>
                      <div className="mt-3 flex items-center gap-4 text-sm text-gray-500">
                        <span>
                          For: {(Number(p.votesFor) / 1e7).toLocaleString()}
                        </span>
                        <span>
                          Against:{" "}
                          {(Number(p.votesAgainst) / 1e7).toLocaleString()}
                        </span>
                        {participationPct !== null && (
                          <span
                            className="text-xs text-gray-400"
                            title="(for + against + abstain) / total supply"
                          >
                            {participationPct.toFixed(1)}% participation
                          </span>
                        )}
                      </div>
                    </div>
                    {p.state === ProposalState.Active && p.endLedger > 0 && (
                      <div className="mt-2">
                        <CountdownTimer
                          state={p.state}
                          startLedger={p.startLedger}
                          endLedger={p.endLedger}
                        />
                      </div>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>

          {hasMore && (
            <div className="mt-8 text-center">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loadingMore ? "Loading..." : "Load More"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function ProposalsPage() {
  return (
    <ErrorBoundary title="Proposals">
      <Suspense
        fallback={
          <div className="max-w-4xl mx-auto px-4 py-8">
            <div className="space-y-4">
              {Array.from({ length: 10 }).map((_, i) => (
                <ProposalCardSkeleton key={i} />
              ))}
            </div>
          </div>
        }
      >
        <ProposalsPageInner />
      </Suspense>
    </ErrorBoundary>
  );
}
