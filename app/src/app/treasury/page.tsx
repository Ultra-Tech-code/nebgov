"use client";

/**
 * Treasury — balances, submit (owners), multi-sig approvals, pending list.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { useWallet } from "../../lib/wallet-context";
import {
  TreasuryClient,
  type TreasurySpendingCap,
  type TreasuryTx,
} from "../../lib/treasury-client";
import { TreasuryBalanceSkeleton } from "../../components/ui/TreasuryBalanceSkeleton";
import {
  type CalldataArgKind,
  type CalldataArgRow,
  encodeCallableCalldata,
  labelPendingTx,
  newArgRow,
  previewCalldata,
} from "../../lib/treasury-calldata";

type StellarNetwork = "mainnet" | "testnet" | "futurenet";

const HORIZON_URLS: Record<StellarNetwork, string> = {
  mainnet: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
  futurenet: "https://horizon-futurenet.stellar.org",
};

type HorizonBalance =
  | { asset_type: "native"; balance: string }
  | {
      asset_type: "credit_alphanum4" | "credit_alphanum12";
      asset_code: string;
      asset_issuer: string;
      balance: string;
    };

function isHex(s: string): boolean {
  return /^[0-9a-fA-F]*$/.test(s);
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!clean || clean.length % 2 !== 0 || !isHex(clean)) {
    throw new Error("Invalid hex string");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export default function TreasuryPage() {
  const { isConnected, publicKey, signTransaction } = useWallet();

  const [xlmBalance, setXlmBalance] = useState<string>("—");
  const [usdcBalance, setUsdcBalance] = useState<string>("—");

  const [txs, setTxs] = useState<TreasuryTx[]>([]);
  const [threshold, setThreshold] = useState<number>(1);
  const [ownerAddresses, setOwnerAddresses] = useState<string[]>([]);
  const [alreadyApproved, setAlreadyApproved] = useState<
    Record<string, boolean>
  >({});
  const [ownerOnChain, setOwnerOnChain] = useState<boolean | null>(null);
  const [ownerCheckComplete, setOwnerCheckComplete] = useState(false);
  const [spendingCap, setSpendingCap] = useState<TreasurySpendingCap | null>(
    null,
  );
  const [spentThisPeriod, setSpentThisPeriod] = useState<bigint>(0n);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [submitTarget, setSubmitTarget] = useState("");
  const [submitFn, setSubmitFn] = useState("");
  const [calldataMode, setCalldataMode] = useState<"builder" | "raw">(
    "builder",
  );
  const [submitDataHex, setSubmitDataHex] = useState("");
  const [argRows, setArgRows] = useState<CalldataArgRow[]>([]);

  const network = (process.env.NEXT_PUBLIC_NETWORK ||
    "testnet") as StellarNetwork;
  const horizonBaseUrl = HORIZON_URLS[network];

  const treasuryContractAddress =
    process.env.NEXT_PUBLIC_TREASURY_ADDRESS || "";
  const treasuryAccountId = process.env.NEXT_PUBLIC_TREASURY_ACCOUNT || "";
  const usdcIssuer = process.env.NEXT_PUBLIC_USDC_ISSUER || "";
  const treasuryTokenAddress =
    process.env.NEXT_PUBLIC_TREASURY_TOKEN_ADDRESS || usdcIssuer;
  const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || undefined;

  const treasuryClient = useMemo(() => {
    if (!treasuryContractAddress) return null;
    return new TreasuryClient({
      network,
      treasuryAddress: treasuryContractAddress,
      rpcUrl,
    });
  }, [network, rpcUrl, treasuryContractAddress]);

  const readViewer = publicKey ?? treasuryAccountId;

  const canWrite = Boolean(isConnected && publicKey && ownerOnChain === true);

  async function fetchBalances() {
    if (!treasuryAccountId) return;

    const res = await fetch(`${horizonBaseUrl}/accounts/${treasuryAccountId}`, {
      method: "GET",
    });
    if (!res.ok)
      throw new Error(`Failed to fetch treasury balances: ${res.status}`);

    const json = (await res.json()) as { balances?: HorizonBalance[] };
    const balances = json.balances ?? [];

    const native = balances.find((b) => b.asset_type === "native") as
      | { asset_type: "native"; balance: string }
      | undefined;
    setXlmBalance(native?.balance ?? "0");

    const usdc = balances.find((b) => {
      if (
        b.asset_type !== "credit_alphanum4" &&
        b.asset_type !== "credit_alphanum12"
      ) {
        return false;
      }
      if (b.asset_code !== "USDC") return false;
      if (usdcIssuer && b.asset_issuer !== usdcIssuer) return false;
      return true;
    }) as
      | {
          asset_type: "credit_alphanum4" | "credit_alphanum12";
          asset_code: string;
          asset_issuer: string;
          balance: string;
        }
      | undefined;
    setUsdcBalance(usdc?.balance ?? "0");
  }

  const fetchPendingTxs = useCallback(
    async (viewer: string) => {
      if (!treasuryClient || !viewer) return;

      const t = await treasuryClient.getThreshold(viewer);
      setThreshold(t);

      const owners = await treasuryClient.getOwners(viewer);
      setOwnerAddresses(owners ?? []);

      const count = await treasuryClient.txCount(viewer);
      const scanLimit = count !== null && count > 0 ? count : 50;
      const results: TreasuryTx[] = [];
      let misses = 0;
      for (let id = 1; id <= scanLimit; id++) {
        const tx = await treasuryClient.getTx(viewer, id);
        if (!tx) {
          misses += 1;
          if (count === null && misses >= 3) break;
          continue;
        }
        misses = 0;
        if (!tx.executed && !tx.cancelled) {
          results.push(tx);
        }
      }
      setTxs(results);

      const approvedMap: Record<string, boolean> = {};
      if (publicKey) {
        await Promise.all(
          results.map(async (tx) => {
            const ok = await treasuryClient.hasApproved(
              viewer,
              Number(tx.id),
              publicKey,
            );
            approvedMap[tx.id.toString()] = ok;
          }),
        );
      }
      setAlreadyApproved(approvedMap);

      if (publicKey) {
        setOwnerCheckComplete(false);
        if (owners && owners.length > 0) {
          setOwnerOnChain(
            owners.some(
              (owner) => owner.toUpperCase() === publicKey.toUpperCase(),
            ),
          );
          setOwnerCheckComplete(true);
        } else {
          const own = await treasuryClient.isOwner(viewer, publicKey);
          setOwnerOnChain(own);
          setOwnerCheckComplete(true);
        }
      } else {
        setOwnerOnChain(null);
        setOwnerCheckComplete(false);
      }

      if (treasuryTokenAddress) {
        const cap = await treasuryClient.getSpendingCap(
          viewer,
          treasuryTokenAddress,
        );
        setSpendingCap(cap);
        if (cap) {
          setSpentThisPeriod(
            await treasuryClient.getSpentThisPeriod(
              viewer,
              treasuryTokenAddress,
            ),
          );
        } else {
          setSpentThisPeriod(0n);
        }
      } else {
        setSpendingCap(null);
        setSpentThisPeriod(0n);
      }
    },
    [publicKey, treasuryClient, treasuryTokenAddress],
  );

  const refreshAll = useCallback(async () => {
    if (!readViewer) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await Promise.all([fetchBalances(), fetchPendingTxs(readViewer)]);
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : "Failed to load treasury data";
      setError(msg);
      if (isConnected && publicKey) {
        setOwnerOnChain(false);
        setOwnerCheckComplete(true);
      }
    } finally {
      setLoading(false);
    }
  }, [fetchPendingTxs, isConnected, publicKey, readViewer]);

  useEffect(() => {
    if (!readViewer) {
      setTxs([]);
      setAlreadyApproved({});
      setThreshold(1);
      setOwnerAddresses([]);
      setOwnerOnChain(null);
      setLoading(false);
      return;
    }
    setOwnerOnChain(null);
    setOwnerCheckComplete(false);
    refreshAll();
  }, [readViewer, refreshAll, treasuryClient]);

  async function handleApprove(txId: bigint) {
    if (!treasuryClient || !publicKey || !canWrite) return;
    const key = txId.toString();
    const before = txs.find((x) => x.id === txId);
    setApproving((m) => ({ ...m, [key]: true }));
    try {
      await treasuryClient.approve(publicKey, Number(txId), signTransaction);
      await fetchPendingTxs(readViewer);
      const executedNow =
        before !== undefined && before.approvals + 1 >= threshold;
      if (executedNow) {
        toast.success(
          "Transaction executed — multi-sig threshold was reached.",
        );
      } else {
        toast.success("Approval recorded.");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Approve failed";
      setError(msg);
      toast.error(msg);
    } finally {
      setApproving((m) => ({ ...m, [key]: false }));
    }
  }

  async function handleSubmitTx(e: React.FormEvent) {
    e.preventDefault();
    if (!treasuryClient || !publicKey || !canWrite) return;
    setSubmitting(true);
    setError(null);
    try {
      let fnName: string;
      let data: Uint8Array;
      if (calldataMode === "raw") {
        fnName = "";
        data = hexToBytes(submitDataHex);
      } else {
        fnName = submitFn.trim();
        data = encodeCallableCalldata(submitFn, argRows);
      }
      const newId = await treasuryClient.submit(
        publicKey,
        submitTarget.trim(),
        fnName,
        data,
        signTransaction,
      );
      setSubmitTarget("");
      setSubmitFn("");
      setSubmitDataHex("");
      setArgRows([]);
      await fetchPendingTxs(readViewer);
      toast.success(
        newId > 0n
          ? `Submitted treasury transaction #${newId}.`
          : "Treasury transaction submitted.",
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Submit failed";
      setError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  const preview =
    calldataMode === "builder"
      ? previewCalldata(submitTarget, submitFn, argRows)
      : submitDataHex.trim()
        ? (() => {
            try {
              const n = hexToBytes(submitDataHex).length;
              return `Raw calldata (${n} bytes) → ${submitTarget.trim() || "…"}`;
            } catch {
              return "Invalid hex calldata.";
            }
          })()
        : "Enter target and raw hex calldata.";

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold text-gray-900 mb-8">Treasury</h1>

      {error && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {!treasuryContractAddress && (
        <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm text-yellow-800">
          Missing{" "}
          <span className="font-mono">NEXT_PUBLIC_TREASURY_ADDRESS</span> in{" "}
          <span className="font-mono">app/.env.local</span>.
        </div>
      )}

      {!treasuryAccountId && (
        <div className="mb-6 bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-sm text-yellow-800">
          Missing{" "}
          <span className="font-mono">NEXT_PUBLIC_TREASURY_ACCOUNT</span>{" "}
          (treasury Stellar account for Horizon balance queries).
        </div>
      )}

      {!isConnected && (
        <div className="mb-6 bg-gray-100 border border-gray-200 rounded-xl p-4 text-sm text-gray-700">
          Connect an owner wallet to submit or approve. Balances and pending
          transactions load using the treasury account when configured.
        </div>
      )}

      {isConnected && publicKey && !ownerCheckComplete && (
        <div className="mb-6 bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-700">
          Verifying treasury owner permissions...
        </div>
      )}

      {isConnected && publicKey && !canWrite && ownerOnChain === false && (
        <div className="mb-6 bg-gray-50 border border-gray-200 rounded-xl p-4 text-sm text-gray-600">
          This wallet is not a treasury owner — you can view balances and
          pending transactions only.
        </div>
      )}

      {/* Balances */}
      {loading ? (
        <TreasuryBalanceSkeleton />
      ) : (
        <div className="grid grid-cols-2 gap-4 mb-8">
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <p className="text-sm text-gray-500">USDC Balance</p>
            <p className="text-2xl font-bold mt-1">{`${usdcBalance} USDC`}</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <p className="text-sm text-gray-500">XLM Balance</p>
            <p className="text-2xl font-bold mt-1">{`${xlmBalance} XLM`}</p>
          </div>
        </div>
      )}

      <div className="mb-8 bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">
          Multisig configuration
        </h2>
        <p className="text-sm text-gray-500">
          {threshold}-of-{ownerAddresses.length || "?"} multisig
        </p>
        {ownerAddresses.length > 0 && (
          <p className="text-xs text-gray-500 mt-2">
            On-chain owners:{" "}
            {ownerAddresses
              .map((address) => `${address.slice(0, 6)}...${address.slice(-4)}`)
              .join(", ")}
          </p>
        )}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">
          Spending cap
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          Current per-period treasury cap and utilization for the configured
          token.
        </p>

        {treasuryTokenAddress ? (
          spendingCap ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Token
                </p>
                <p className="mt-1 font-mono text-sm text-gray-800 break-all">
                  {spendingCap.token}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Cap
                </p>
                <p className="mt-1 text-sm text-gray-800">
                  {spendingCap.maxAmount.toString()} units /{" "}
                  {spendingCap.periodLedgers} ledgers
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-gray-500">
                  Used
                </p>
                <p className="mt-1 text-sm text-gray-800">
                  {spentThisPeriod.toString()} units
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              No spending cap is configured for{" "}
              <span className="font-mono">{treasuryTokenAddress}</span>.
            </p>
          )
        ) : (
          <p className="text-sm text-gray-500">
            Set{" "}
            <span className="font-mono">
              NEXT_PUBLIC_TREASURY_TOKEN_ADDRESS
            </span>{" "}
            or
            <span className="font-mono"> NEXT_PUBLIC_USDC_ISSUER</span> to show
            utilization.
          </p>
        )}
      </div>

      {/* Submit */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-8">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">
          Submit transaction
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          Owners propose a target contract and calldata. Approvals execute
          automatically when the threshold is met.
        </p>

        {!canWrite && (
          <p className="text-sm text-gray-500 mb-4 italic">
            Read-only — owner wallet required to submit.
          </p>
        )}

        <form onSubmit={handleSubmitTx} className="space-y-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              Target contract / account
            </label>
            <input
              type="text"
              value={submitTarget}
              onChange={(e) => setSubmitTarget(e.target.value)}
              placeholder="C… or G…"
              disabled={!canWrite}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50 disabled:text-gray-400"
              required
            />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setCalldataMode("builder")}
              disabled={!canWrite}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                calldataMode === "builder"
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              } disabled:opacity-50`}
            >
              Argument builder
            </button>
            <button
              type="button"
              onClick={() => setCalldataMode("raw")}
              disabled={!canWrite}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                calldataMode === "raw"
                  ? "bg-indigo-600 text-white"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              } disabled:opacity-50`}
            >
              Raw hex
            </button>
          </div>

          {calldataMode === "builder" ? (
            <>
              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  Function name
                </label>
                <input
                  type="text"
                  value={submitFn}
                  onChange={(e) => setSubmitFn(e.target.value)}
                  placeholder="transfer"
                  disabled={!canWrite}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50"
                  required
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-500">Arguments</span>
                  <button
                    type="button"
                    disabled={!canWrite}
                    onClick={() => setArgRows((r) => [...r, newArgRow()])}
                    className="text-xs font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                  >
                    + Add argument
                  </button>
                </div>
                <ul className="space-y-2">
                  {argRows.map((row, idx) => (
                    <li
                      key={row.id}
                      className="flex flex-wrap gap-2 items-center border border-gray-100 rounded-lg p-2"
                    >
                      <select
                        value={row.kind}
                        disabled={!canWrite}
                        onChange={(e) => {
                          const kind = e.target.value as CalldataArgKind;
                          setArgRows((rows) =>
                            rows.map((x) =>
                              x.id === row.id ? { ...x, kind } : x,
                            ),
                          );
                        }}
                        className="border border-gray-200 rounded-md text-xs py-1.5 px-2"
                      >
                        <option value="address">address</option>
                        <option value="i128">i128</option>
                        <option value="u64">u64</option>
                        <option value="string">string</option>
                        <option value="bool">bool</option>
                      </select>
                      <input
                        type="text"
                        value={row.value}
                        disabled={!canWrite}
                        onChange={(e) => {
                          const v = e.target.value;
                          setArgRows((rows) =>
                            rows.map((x) =>
                              x.id === row.id ? { ...x, value: v } : x,
                            ),
                          );
                        }}
                        placeholder={
                          row.kind === "bool"
                            ? "true / false"
                            : `value ${idx + 1}`
                        }
                        className="flex-1 min-w-[8rem] border border-gray-200 rounded-md text-sm px-2 py-1.5 font-mono"
                      />
                      <button
                        type="button"
                        disabled={!canWrite}
                        onClick={() =>
                          setArgRows((rows) =>
                            rows.filter((x) => x.id !== row.id),
                          )
                        }
                        className="text-xs text-red-600 hover:text-red-800 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                Calldata (hex)
              </label>
              <textarea
                value={submitDataHex}
                onChange={(e) => setSubmitDataHex(e.target.value)}
                placeholder="0x…"
                disabled={!canWrite}
                rows={3}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50"
                required
              />
            </div>
          )}

          <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-sm text-slate-800">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
              Preview
            </span>
            <p className="mt-1 font-mono text-xs sm:text-sm break-all">
              {preview}
            </p>
          </div>

          <button
            type="submit"
            disabled={!canWrite || submitting || !treasuryClient || !publicKey}
            className="w-full bg-indigo-600 text-white py-2.5 rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? "Submitting…" : "Submit to treasury"}
          </button>
        </form>
      </div>

      {/* Pending */}
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        Pending transactions
      </h2>
      <div className="space-y-3">
        {txs.length === 0 && !loading && (
          <div className="bg-white border border-gray-200 rounded-xl p-5 text-sm text-gray-500">
            No pending transactions.
          </div>
        )}

        {txs.map((tx) => {
          const approvals = tx.approvals;
          const has = alreadyApproved[tx.id.toString()] ?? false;
          const pct =
            threshold > 0
              ? Math.min(100, Math.round((approvals / threshold) * 100))
              : 0;
          const oneMore = threshold - approvals;
          const atThresholdVisual = oneMore <= 1 && oneMore > 0;

          return (
            <div
              key={tx.id.toString()}
              className={`bg-white border rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 ${
                atThresholdVisual
                  ? "border-amber-300 ring-1 ring-amber-100"
                  : "border-gray-200"
              }`}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 leading-snug">
                  {labelPendingTx(tx.target, tx.dataHex, tx.fnName)}
                </p>
                <p className="text-xs text-gray-400 font-mono mt-1">
                  #{tx.id.toString()}
                </p>
                <div className="mt-3 flex items-center gap-3 flex-wrap">
                  <span className="text-sm text-gray-700 font-medium tabular-nums">
                    {approvals}/{threshold}
                  </span>
                  <div className="w-48 max-w-full bg-gray-100 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full transition-all ${
                        atThresholdVisual ? "bg-amber-500" : "bg-indigo-600"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {oneMore === 1 && (
                    <span className="text-xs font-medium text-amber-700">
                      One more approval executes this tx
                    </span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleApprove(tx.id)}
                disabled={
                  !isConnected ||
                  !canWrite ||
                  has ||
                  approving[tx.id.toString()] ||
                  !treasuryClient ||
                  !publicKey
                }
                className={`shrink-0 text-sm rounded-lg px-4 py-2 font-medium border transition-colors ${
                  has
                    ? "text-gray-400 border-gray-100 bg-gray-50 cursor-not-allowed"
                    : "text-indigo-600 border-indigo-200 hover:bg-indigo-50"
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {has
                  ? "You approved"
                  : approving[tx.id.toString()]
                    ? "Approving…"
                    : "Approve"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
