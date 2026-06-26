"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import {
  VoteSupport,
  ProposalState,
  VotesClient,
  GovernorClient,
  VoteType,
  type GovernorSettings,
  type Network,
} from "@nebgov/sdk";
import {
  AlertTriangle,
  Info,
  ExternalLink,
  Loader2,
  MessageSquare,
} from "lucide-react";
import { useWallet } from "../../../lib/wallet-context";
import { DelegateModal } from "../../../components/DelegateModal";
import { VotingModal } from "../../../components/VotingModal";
import {
  fetchProposalMetadata,
  verifyMetadataHash,
} from "../../../lib/metadata";
import { fetchProposalVotes, type ProposalVote } from "../../../lib/backend";
import { ShareButton } from "../../../components/ShareButton";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from "recharts";

import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { ErrorState } from "../../../components/ErrorState";
import { useTheme } from "../../../hooks/useTheme";
import {
  getErrorMessage,
  reportFrontendError,
} from "../../../lib/frontend-error";
import { ProposalDetailSkeleton } from "../../../components/ui/ProposalDetailSkeleton";

interface Props {
  params: { id: string };
}

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function supportLabel(support: number): string {
  if (support === VoteSupport.For) return "For";
  if (support === VoteSupport.Against) return "Against";
  return "Abstain";
}

function reasonPreview(reason: string, expanded: boolean): string {
  if (expanded || reason.length <= 200) return reason;
  return `${reason.slice(0, 200)}...`;
}

// Initial state for proposal to avoid undefined errors during loading
const INITIAL_PROPOSAL = {
  id: 0n,
  description: "Loading...",
  descriptionHash: "",
  metadataUri: "",
  state: ProposalState.Pending,
  votesFor: 0n,
  votesAgainst: 0n,
  votesAbstain: 0n,
  endLedger: 0,
  proposer: "",
  quorum: 0n,
};

export default function ProposalDetailClient({ params }: Props) {
  const proposalId = useMemo(() => {
    try {
      return BigInt(params.id);
    } catch {
      throw new Error(`Invalid proposal id: ${params.id}`);
    }
  }, [params.id]);
  const [proposal, setProposal] = useState(INITIAL_PROPOSAL);
  const [loading, setLoading] = useState(true);
  const [proposalLoadError, setProposalLoadError] = useState<string | null>(
    null,
  );
  const [metadata, setMetadata] = useState<string | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [hashMismatched, setHashMismatched] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [quorumReached, setQuorumReached] = useState<boolean | null>(null);
  const [quorumValue, setQuorumValue] = useState<bigint>(0n);

  const [voted, setVoted] = useState(false);
  const [selectedSupport, setSelectedSupport] = useState<VoteSupport | null>(
    null,
  );
  const [delegateModalOpen, setDelegateModalOpen] = useState(false);
  const [voteModalOpen, setVoteModalOpen] = useState(false);
  const [votingPower, setVotingPower] = useState<bigint>(0n);
  const [delegationLoading, setDelegationLoading] = useState(false);
  const [isVoting, setIsVoting] = useState(false);
  const [voteSuccess, setVoteSuccess] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [votedSupport, setVotedSupport] = useState<VoteSupport | null>(null);
  const [voteType, setVoteType] = useState<VoteType>(VoteType.Simple);
  const [currentDelegatee, setCurrentDelegatee] = useState<string | null>(null);
  const [delegationError, setDelegationError] = useState<string | null>(null);

  // Votes pagination
  const [votes, setVotes] = useState<ProposalVote[]>([]);
  const [votesPage, setVotesPage] = useState(0);
  const [votesLoading, setVotesLoading] = useState(false);
  const [votesError, setVotesError] = useState<string | null>(null);
  const [votesTotal, setVotesTotal] = useState(0);
  const [votesHasMore, setVotesHasMore] = useState(false);
  const [votesSort, setVotesSort] = useState<"newest" | "weight" | "address">(
    "newest",
  );
  const [exportingCsv, setExportingCsv] = useState(false);
  const [expandedReasons, setExpandedReasons] = useState<
    Record<number, boolean>
  >({});

  const loadVotes = useCallback(
    async (pageNum: number, append = false) => {
      setVotesLoading(true);
      setVotesError(null);
      try {
        const result = await fetchProposalVotes(
          params.id,
          pageNum,
          20,
          votesSort,
        );
        if (append) {
          setVotes((prev) => [...prev, ...result.votes]);
        } else {
          setVotes(result.votes);
        }
        setVotesTotal(result.total);
        setVotesHasMore(result.hasMore);
      } catch (err) {
        reportFrontendError("proposal_votes_load", err, {
          proposalId: params.id,
          page: pageNum,
          append,
          sort: votesSort,
        });
        setVotesError(getErrorMessage(err));
      } finally {
        setVotesLoading(false);
      }
    },
    [params.id, votesSort],
  );

  const loadMoreVotes = () => {
    if (!votesLoading && votesHasMore) {
      loadVotes(votesPage + 1, true);
      setVotesPage((p) => p + 1);
    }
  };

  const { publicKey, isConnected, signTransaction, connect } = useWallet();
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const [shareUrl, setShareUrl] = useState<string>("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    setShareUrl(`${window.location.origin}/proposal/${params.id}`);
  }, [params.id]);

  const config = useMemo(() => {
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
      ...(rpcUrl && { rpcUrl }),
    };
  }, []);

  const votesClient = useMemo(
    () => (config ? new VotesClient(config) : null),
    [config],
  );
  const governorClient = useMemo(
    () => (config ? new GovernorClient(config) : null),
    [config],
  );

  const loadProposal = useCallback(async () => {
    if (!governorClient) return;
    setLoading(true);
    setProposalLoadError(null);
    try {
      const p = await governorClient.getProposal(proposalId);
      const state = await governorClient.getProposalState(proposalId);
      setProposal({
        ...INITIAL_PROPOSAL,
        ...p,
        state,
      });
      
      // Fetch quorum data for non-pending proposals
      if (state !== ProposalState.Pending) {
        const [reached, quorum] = await Promise.all([
          governorClient.isQuorumReached(proposalId),
          governorClient.getQuorum(proposalId),
        ]);
        setQuorumReached(reached);
        setQuorumValue(quorum);
      }
    } catch (err) {
      reportFrontendError("proposal_detail_load", err, {
        proposalId: params.id,
      });
      setProposalLoadError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [governorClient, proposalId, params.id]);

  useEffect(() => {
    loadProposal();
  }, [loadProposal]);

  useEffect(() => {
    if (!governorClient) return;
    governorClient
      .getSettings()
      .then((s: GovernorSettings) => setVoteType(s.voteType))
      .catch(() => {});
  }, [governorClient]);

  useEffect(() => {
    if (!votesClient || !publicKey) {
      setCurrentDelegatee(null);
      return;
    }

    let cancelled = false;
    void votesClient
      .getDelegatee(publicKey)
      .then((delegatee) => {
        if (!cancelled) setCurrentDelegatee(delegatee);
      })
      .catch(() => {
        if (!cancelled) setCurrentDelegatee(null);
      });

    return () => {
      cancelled = true;
    };
  }, [publicKey, votesClient]);

  const loadMetadata = useCallback(async () => {
    if (!proposal.metadataUri) return;
    setMetadataLoading(true);
    setFetchError(null);
    try {
      const content = await fetchProposalMetadata(proposal.metadataUri);
      setMetadata(content);
      const isMatch = await verifyMetadataHash(
        content,
        proposal.descriptionHash,
      );
      setHashMismatched(!isMatch);
    } catch (err) {
      reportFrontendError("proposal_metadata_load", err, {
        proposalId: params.id,
        metadataUri: proposal.metadataUri,
      });
      setFetchError(getErrorMessage(err));
    } finally {
      setMetadataLoading(false);
    }
  }, [proposal.metadataUri, proposal.descriptionHash, params.id]);

  useEffect(() => {
    if (proposal.id !== 0n) {
      loadMetadata();
    }
  }, [proposal.id, loadMetadata]);

  async function refreshDelegation() {
    if (!votesClient || !publicKey) return;
    setDelegationLoading(true);
    setDelegationError(null);
    try {
      const power = await votesClient.getVotes(publicKey);
      setVotingPower(power);
    } catch (err) {
      reportFrontendError("proposal_delegation_load", err, {
        proposalId: params.id,
        publicKey,
      });
      setDelegationError(getErrorMessage(err));
    } finally {
      setDelegationLoading(false);
    }
  }

  useEffect(() => {
    if (isConnected) {
      refreshDelegation();
    }
  }, [isConnected, votesClient, publicKey]);

  useEffect(() => {
    loadVotes(0, false);
  }, [loadVotes]);

  // Transform data for Recharts
  const chartData = useMemo(
    () => [
      { name: "For", votes: Number(proposal.votesFor) },
      { name: "Against", votes: Number(proposal.votesAgainst) },
      { name: "Abstain", votes: Number(proposal.votesAbstain) },
    ],
    [proposal.votesFor, proposal.votesAgainst, proposal.votesAbstain],
  );

  const COLORS: Record<string, string> = {
    For: "#10b981", // green-500
    Against: "#f43f5e", // rose-500
    Abstain: isDark ? "#475569" : "#94a3b8", // slate-600 : slate-400
  };

  const totalVotes =
    proposal.votesFor + proposal.votesAgainst + proposal.votesAbstain;

  async function handleCastVote() {
    if (selectedSupport === null || !governorClient || !publicKey || isVoting)
      return;

    setIsVoting(true);
    setVoteError(null);
    setVoteSuccess(false);

    try {
      await governorClient.castVoteWithSign(
        publicKey,
        proposalId,
        selectedSupport,
        signTransaction,
      );

      setVoteSuccess(true);
      setVotedSupport(selectedSupport);
      setVoted(true);
      await loadProposal();
    } catch (err: any) {
      console.error("Vote submission failed:", err);
      let message = "An unknown error occurred while casting your vote.";

      const errStr = String(err);
      if (
        errStr.includes("already voted") ||
        errStr.includes("Already voted") ||
        errStr.includes("Error(Contract, #1)")
      ) {
        message = "You have already voted on this proposal.";
      } else if (
        errStr.includes("Proposal not active") ||
        errStr.includes("Error(Contract, #2)")
      ) {
        message = "This proposal is no longer accepting votes.";
      } else if (
        errStr.includes("zero voting power") ||
        errStr.includes("Insufficient voting power") ||
        errStr.includes("Error(Contract, #3)")
      ) {
        message =
          "You do not have sufficient voting power to vote on this proposal.";
      }

      setVoteError(message);
    } finally {
      setIsVoting(false);
    }
  }

  async function exportVotesCsv() {
    setExportingCsv(true);
    setVotesError(null);
    try {
      const rows: ProposalVote[] = [];
      let page = 0;
      while (true) {
        const result = await fetchProposalVotes(
          params.id,
          page,
          100,
          votesSort,
        );
        rows.push(...result.votes);
        if (!result.hasMore) break;
        page += 1;
      }

      const header = ["voter", "support", "weight", "reason", "ledger"].join(
        ",",
      );
      const lines = rows.map((v: any) =>
        [
          csvEscape(v.voter),
          csvEscape(supportLabel(v.support)),
          csvEscape(v.weight),
          csvEscape(v.reason ?? ""),
          csvEscape(v.ledger ?? ""),
        ].join(","),
      );
      const csv = [header, ...lines].join("\n");

      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `proposal-${params.id}-votes.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      reportFrontendError("proposal_votes_export", err, {
        proposalId: params.id,
        sort: votesSort,
      });
      setVotesError(getErrorMessage(err));
    } finally {
      setExportingCsv(false);
    }
  }

  if (loading) {
    return <ProposalDetailSkeleton />;
  }

  if (proposalLoadError && proposal.id === 0n) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <ErrorState
          title="Failed to load proposal"
          message={proposalLoadError}
          onRetry={() => void loadProposal()}
        />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      {proposalLoadError ? (
        <ErrorState
          title="Proposal data is out of date"
          message={proposalLoadError}
          onRetry={() => void loadProposal()}
          className="mb-6"
        />
      ) : null}

      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="flex items-center gap-2">
          <p className="text-sm text-gray-400">Proposal #{params.id}</p>
          <div
            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
              proposal.state === ProposalState.Active
                ? "bg-green-100 text-green-700"
                : "bg-gray-100 text-gray-600"
            }`}
          >
            {ProposalState[proposal.state]}
          </div>
        </div>
        {shareUrl ? (
          <ShareButton url={shareUrl} title={`Proposal #${params.id}`} />
        ) : null}
      </div>

      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
        {proposal.description}
      </h1>

      <p className="text-sm text-gray-500 mb-6">
        Proposed by <span className="font-mono">{proposal.proposer}</span>
      </p>

      {/* Veto Window Status - shown when proposal is Queued */}
      {proposal.state === ProposalState.Queued && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-blue-600 animate-pulse"></div>
            <div>
              <p className="text-sm font-semibold text-blue-900">
                Veto Window Open
              </p>
              <p className="text-xs text-blue-700 mt-1">
                The guardian can cancel this proposal during the veto window
                before execution becomes possible.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Hash Mismatch Warning */}
      {hashMismatched && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 flex gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-sm">
            <h3 className="font-semibold text-amber-800">
              Content Integrity Warning
            </h3>
            <p className="text-amber-700 mt-0.5">
              The external content fetched for this proposal does not match the
              hash stored on-chain. The displayed description may have been
              tampered with.
            </p>
            <div className="mt-2 space-y-1 font-mono text-[11px]">
              <p className="text-gray-500">
                On-chain: {proposal.descriptionHash.substring(0, 16)}...
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Fetch Error Info */}
      {fetchError && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6 flex gap-3 text-sm">
          <Info className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
          <div className="text-blue-700">
            <p className="font-semibold text-blue-800">Metadata Unreachable</p>
            <p className="mt-0.5">
              Could not load the full description. Check the URI directly below.
            </p>
            <p className="mt-2 font-mono text-[11px] text-gray-500">
              Hash: {proposal.descriptionHash}
            </p>
          </div>
        </div>
      )}

      {/* Metadata / Description Section */}
      <ErrorBoundary
        title="Failed to render proposal description"
        resetKeys={[
          proposal.id.toString(),
          proposal.descriptionHash,
          metadata ?? "",
          fetchError ?? "",
        ]}
        className="mb-6"
      >
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">
            Description
          </h2>
          {proposal.metadataUri && (
            <a
              href={
                proposal.metadataUri.startsWith("ipfs://")
                  ? `https://ipfs.io/ipfs/${proposal.metadataUri.replace("ipfs://", "")}`
                  : proposal.metadataUri
              }
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 flex items-center gap-1 text-xs hover:underline"
            >
              View Source <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>

        {metadataLoading ? (
          <div className="flex items-center gap-2 text-gray-400 text-sm py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Fetching off-chain
            content...
          </div>
        ) : metadata ? (
          <div className="prose prose-sm max-w-none text-gray-800 dark:text-gray-200 whitespace-pre-wrap">
            {metadata}
          </div>
        ) : (
          <p className="text-gray-400 italic py-4">
            {fetchError ? "Content unavailable" : proposal.description}
          </p>
        )}
      </div>
      </ErrorBoundary>

      {/* Delegation */}
      <ErrorBoundary
        title="Failed to render voting power"
        resetKeys={[
          publicKey ?? "",
          currentDelegatee ?? "",
          votingPower.toString(),
          delegationError ?? "",
        ]}
        className="mb-6"
      >
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6">
        {delegationError ? (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <div className="flex items-center justify-between gap-3">
              <span>{delegationError}</span>
              <button
                type="button"
                onClick={() => void refreshDelegation()}
                className="shrink-0 rounded-lg border border-amber-300 px-3 py-1 text-xs font-medium hover:bg-amber-100"
              >
                Retry
              </button>
            </div>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-1">
              Your Voting Power
            </h2>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold text-gray-900 dark:text-white font-mono">
                {delegationLoading
                  ? "..."
                  : (Number(votingPower) / 10 ** 7).toLocaleString()}
              </span>
              <span className="text-sm text-gray-400">NEB</span>
            </div>
          </div>
          <button
            onClick={() => setDelegateModalOpen(true)}
            className="px-4 py-2 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            Delegate
          </button>
        </div>
      </div>
      </ErrorBoundary>

      {/* Vote bars */}
      <ErrorBoundary
        title="Failed to render vote totals"
        resetKeys={[
          proposal.id.toString(),
          proposal.votesFor.toString(),
          proposal.votesAgainst.toString(),
          proposal.votesAbstain.toString(),
          proposal.quorum.toString(),
          voteType,
        ]}
        className="mb-6"
      >
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6 space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">
            Current Votes
          </h2>
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
              voteType === VoteType.Quadratic
                ? "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300"
                : voteType === VoteType.Extended
                  ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                  : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
            }`}
          >
            {voteType}
          </span>
        </div>

        <div className="h-48 w-full mt-4">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ left: -20, right: 20, top: 0, bottom: 0 }}
            >
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="name"
                axisLine={false}
                tickLine={false}
                tick={{
                  fontSize: 12,
                  fontWeight: 500,
                  fill: isDark ? "#94a3b8" : "#64748b",
                }}
              />
              <Tooltip
                cursor={{
                  fill: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.02)",
                }}
                contentStyle={{
                  borderRadius: "12px",
                  border: "none",
                  boxShadow: "0 10px 15px -3px rgba(0,0,0,0.1)",
                  backgroundColor: isDark ? "#1f2937" : "#ffffff",
                  color: isDark ? "#f3f4f6" : "#111827",
                }}
                itemStyle={{ color: isDark ? "#f3f4f6" : "#111827" }}
              />
              <Bar
                dataKey="votes"
                radius={[0, 4, 4, 0]}
                animationDuration={800}
                barSize={28}
              >
                {chartData.map((entry) => (
                  <Cell key={entry.name} fill={COLORS[entry.name]} />
                ))}
              </Bar>
              {proposal.quorum && (
                <ReferenceLine
                  x={Number(proposal.quorum)}
                  stroke="#ef4444"
                  strokeDasharray="3 3"
                  label={{
                    position: "top",
                    value: "Quorum",
                    fill: "#ef4444",
                    fontSize: 10,
                  }}
                />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="grid grid-cols-3 gap-4 border-t border-gray-100 dark:border-gray-700 pt-6">
          <div>
            <p className="text-xs text-gray-400 font-medium mb-1 uppercase">
              For
            </p>
            <p className="font-mono text-lg font-bold text-emerald-600">
              {(Number(proposal.votesFor) / 10 ** 7).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-400 font-medium mb-1 uppercase">
              Against
            </p>
            <p className="font-mono text-lg font-bold text-rose-600">
              {(Number(proposal.votesAgainst) / 10 ** 7).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-gray-400 font-medium mb-1 uppercase">
              Abstain
            </p>
            <p className="font-mono text-lg font-bold text-slate-500 dark:text-slate-400">
              {(Number(proposal.votesAbstain) / 10 ** 7).toLocaleString()}
            </p>
          </div>
        </div>

        {/* Quorum Progress Bar */}
        {proposal.state !== ProposalState.Pending && quorumValue > 0n && (
          <div className="border-t border-gray-100 dark:border-gray-700 pt-6 mt-6">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-400 font-medium uppercase">Quorum Progress</p>
              <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                quorumReached 
                  ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" 
                  : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
              }`}>
                {quorumReached ? "Quorum reached ✓" : "Quorum not yet reached"}
              </span>
            </div>
            <div className="relative h-4 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div 
                className={`h-full ${quorumColor} transition-all duration-500`}
                style={{ width: `${Math.min(quorumPercentage, 100)}%` }}
              />
              <div 
                className="absolute top-0 bottom-0 w-0.5 bg-red-500"
                style={{ left: '100%' }}
              />
            </div>
            <div className="flex justify-between mt-2 text-xs text-gray-500">
              <span>
                {quorumPercentage}% ({(Number(quorumVotes) / 10 ** 7).toLocaleString()} / {(Number(quorumValue) / 10 ** 7).toLocaleString()} votes needed)
              </span>
              <span>▲ quorum threshold</span>
            </div>
          </div>
        )}
      </div>
      </ErrorBoundary>

      {/* Voting UI */}
      {proposal.state === ProposalState.Active && !voted && (
        <ErrorBoundary
          title="Failed to render voting controls"
          resetKeys={[
            proposal.id.toString(),
            selectedSupport ?? "none",
            voteError ?? "",
            isConnected,
          ]}
        >
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-4">
            Cast Your Vote
          </h2>

          {!isConnected ? (
            <div className="bg-indigo-50 dark:bg-slate-900/80 border border-indigo-200 dark:border-indigo-800 rounded-2xl p-5 mb-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-base font-semibold text-slate-900 dark:text-white">
                    Connect your wallet to vote on this proposal
                  </p>
                  <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                    You'll need GOV tokens to participate.
                  </p>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <button
                    onClick={connect}
                    className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-indigo-700"
                  >
                    Connect Wallet
                  </button>
                  <a
                    href="https://github.com/nebgov/nebgov/blob/main/docs/tutorial.md"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center rounded-lg border border-transparent bg-white px-4 py-2 text-sm font-medium text-indigo-700 shadow-sm hover:bg-indigo-50 dark:bg-slate-800 dark:text-indigo-200 dark:hover:bg-slate-700"
                  >
                    Learn about governance →
                  </a>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row gap-3 mb-4">
                {[
                  { label: "For", value: VoteSupport.For, aria: "Vote For" },
                  {
                    label: "Against",
                    value: VoteSupport.Against,
                    aria: "Vote Against",
                  },
                  {
                    label: "Abstain",
                    value: VoteSupport.Abstain,
                    aria: "Vote Abstain",
                  },
                ].map(({ label, value, aria }) => (
                  <button
                    key={label}
                    onClick={() => setSelectedSupport(value)}
                    disabled={isVoting}
                    aria-label={aria}
                    className={`flex-1 py-3 rounded-lg border-2 font-medium transition-all
                      ${
                        selectedSupport === value
                          ? "border-indigo-600 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300"
                          : "border-gray-100 dark:border-gray-700 hover:border-gray-200 dark:hover:border-gray-600 text-gray-600 dark:text-gray-400"
                      }
                      ${isVoting ? "opacity-50 cursor-not-allowed" : ""}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {voteError && (
                <div
                  role="alert"
                  className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex gap-2 items-start"
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  {voteError}
                </div>
              )}

              <button
                onClick={handleCastVote}
                disabled={selectedSupport === null || isVoting}
                aria-busy={isVoting}
                className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
              >
                {isVoting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Submitting Vote...
                  </>
                ) : (
                  "Submit Vote"
                )}
              </button>
            </>
          )}
        </div>
        </ErrorBoundary>
      )}

      {voted && (
        <div
          className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-center"
          aria-live="polite"
        >
          <p className="text-emerald-800 font-medium">
            Your vote{" "}
            {votedSupport !== null ? `(${VoteSupport[votedSupport]})` : ""} has
            been recorded!
          </p>
        </div>
      )}

      {/* Votes List with Pagination */}
      <ErrorBoundary
        title="Failed to render votes list"
        resetKeys={[
          proposal.id.toString(),
          votes.length,
          votesTotal,
          votesSort,
          votesError ?? "",
        ]}
        className="mt-6"
      >
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 mt-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">
            Votes
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400">
              Showing {votes.length} of {votesTotal} votes
            </span>
            <button
              type="button"
              onClick={exportVotesCsv}
              disabled={exportingCsv || votesTotal === 0}
              className="px-3 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-900 disabled:opacity-50"
            >
              {exportingCsv ? "Exporting..." : "Export CSV"}
            </button>
          </div>
        </div>

        {votesError ? (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <div className="flex items-center justify-between gap-3">
              <span>{votesError}</span>
              <button
                type="button"
                onClick={() => void loadVotes(votesPage, false)}
                className="shrink-0 rounded-lg border border-amber-300 px-3 py-1 text-xs font-medium hover:bg-amber-100"
              >
                Retry
              </button>
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs text-gray-500">Sort by:</span>
          <button
            onClick={() => {
              setVotesSort("newest");
              setVotesPage(0);
            }}
            className={`px-2 py-1 text-xs rounded ${votesSort === "newest" ? "bg-indigo-600 text-white" : "bg-gray-100 dark:bg-gray-700"}`}
          >
            Newest
          </button>
          <button
            onClick={() => {
              setVotesSort("weight");
              setVotesPage(0);
            }}
            className={`px-2 py-1 text-xs rounded ${votesSort === "weight" ? "bg-indigo-600 text-white" : "bg-gray-100 dark:bg-gray-700"}`}
          >
            Weight
          </button>
          <button
            onClick={() => {
              setVotesSort("address");
              setVotesPage(0);
            }}
            className={`px-2 py-1 text-xs rounded ${votesSort === "address" ? "bg-indigo-600 text-white" : "bg-gray-100 dark:bg-gray-700"}`}
          >
            Address
          </button>
        </div>

        {votesLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : votes.length === 0 ? (
          <p className="text-gray-400 text-sm py-8 text-center">No votes yet</p>
        ) : (
          <ul className="space-y-2">
            {votes.map((vote) => {
              const reason = vote.reason?.trim() ?? "";
              const hasReason = reason.length > 0;
              const expanded = Boolean(expandedReasons[vote.id]);
              const reasonText = reasonPreview(reason, expanded);
              return (
                <li
                  key={vote.id}
                  className="group p-3 bg-gray-50 dark:bg-gray-900 rounded-lg"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm">
                        {vote.voter.slice(0, 6)}...{vote.voter.slice(-4)}
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          vote.support === VoteSupport.For
                            ? "bg-green-100 text-green-700"
                            : vote.support === VoteSupport.Against
                              ? "bg-red-100 text-red-700"
                              : "bg-gray-200 text-gray-600"
                        }`}
                      >
                        {supportLabel(vote.support)}
                      </span>
                      {hasReason && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedReasons((prev) => ({
                              ...prev,
                              [vote.id]: !prev[vote.id],
                            }))
                          }
                          className="inline-flex items-center gap-1 rounded-full border border-indigo-200 px-2 py-0.5 text-[11px] text-indigo-700 hover:bg-indigo-50"
                          aria-label={`Toggle vote reason for ${vote.voter}`}
                        >
                          <MessageSquare className="w-3 h-3" />
                          Reason
                        </button>
                      )}
                    </div>
                    <span className="text-sm font-mono text-gray-600 dark:text-gray-400">
                      {(Number(vote.weight) / 10 ** 7).toLocaleString()} NEB
                    </span>
                  </div>

                  {hasReason && (
                    <div
                      className={`mt-3 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 ${
                        expanded ? "block" : "hidden md:group-hover:block"
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words">
                        {reasonText}
                      </p>
                      {reason.length > 200 && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedReasons((prev) => ({
                              ...prev,
                              [vote.id]: !prev[vote.id],
                            }))
                          }
                          className="mt-2 text-xs font-medium text-indigo-600 hover:text-indigo-800"
                        >
                          {expanded ? "Show less" : "Show more"}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {votesHasMore && (
          <button
            onClick={loadMoreVotes}
            disabled={votesLoading}
            className="w-full mt-4 py-2 text-sm text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-lg transition-colors disabled:opacity-50"
          >
            {votesLoading ? "Loading..." : "Load more"}
          </button>
        )}
      </div>
      </ErrorBoundary>

      <ErrorBoundary
        title="Failed to render governance actions"
        resetKeys={[delegateModalOpen, voteModalOpen, proposal.id.toString()]}
      >
        <DelegateModal
          open={delegateModalOpen}
          onClose={() => setDelegateModalOpen(false)}
          onDelegated={refreshDelegation}
          currentDelegatee={currentDelegatee}
        />
        <VotingModal
          open={voteModalOpen}
          onClose={() => setVoteModalOpen(false)}
          proposalId={proposalId}
          preselectedSupport={selectedSupport}
          votingPower={votingPower}
          voteType={voteType}
          onVoted={() => {
            setVoted(true);
            void loadProposal();
          }}
          onOpenDelegate={() => setDelegateModalOpen(true)}
          governorClient={governorClient}
        />
      </ErrorBoundary>
    </div>
  );
}
