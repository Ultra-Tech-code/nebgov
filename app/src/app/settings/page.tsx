"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { GovernorClient, type GovernorSettings } from "@nebgov/sdk";
import { xdr } from "@stellar/stellar-sdk";
import { readGovernorConfig } from "../../lib/nebgov-env";
import { useWallet } from "../../lib/wallet-context";

type SettingsForm = {
  votingDelay: string;
  votingPeriod: string;
  quorumNumerator: string;
  proposalThreshold: string;
  guardian: string;
  voteType: GovernorSettings["voteType"];
  proposalGracePeriod: string;
  useDynamicQuorum: boolean;
  reflectorOracle: string;
  minQuorumUsd: string;
  maxCalldataSize: string;
  proposalCooldown: string;
  maxProposalsPerPeriod: string;
  proposalPeriodDuration: string;
};

const FIELD_LABELS: Record<keyof SettingsForm, string> = {
  votingDelay: "voting_delay",
  votingPeriod: "voting_period",
  quorumNumerator: "quorum_numerator",
  proposalThreshold: "proposal_threshold",
  guardian: "guardian",
  voteType: "vote_type",
  proposalGracePeriod: "proposal_grace_period",
  useDynamicQuorum: "use_dynamic_quorum",
  reflectorOracle: "reflector_oracle",
  minQuorumUsd: "min_quorum_usd",
  maxCalldataSize: "max_calldata_size",
  proposalCooldown: "proposal_cooldown",
  maxProposalsPerPeriod: "max_proposals_per_period",
  proposalPeriodDuration: "proposal_period_duration",
};

function toForm(settings: GovernorSettings): SettingsForm {
  return {
    votingDelay: String(settings.votingDelay),
    votingPeriod: String(settings.votingPeriod),
    quorumNumerator: String(settings.quorumNumerator),
    proposalThreshold: settings.proposalThreshold.toString(),
    guardian: settings.guardian,
    voteType: settings.voteType,
    proposalGracePeriod: String(settings.proposalGracePeriod),
    useDynamicQuorum: Boolean(settings.useDynamicQuorum),
    reflectorOracle: settings.reflectorOracle ?? "",
    minQuorumUsd: (settings.minQuorumUsd ?? 0n).toString(),
    maxCalldataSize: String(settings.maxCalldataSize ?? 10_000),
    proposalCooldown: String(settings.proposalCooldown ?? 100),
    maxProposalsPerPeriod: String(settings.maxProposalsPerPeriod ?? 5),
    proposalPeriodDuration: String(settings.proposalPeriodDuration ?? 10_000),
  };
}

const LEDGER_SECONDS = 5;

function ledgerToTimeEstimate(ledgers: number): string {
  const totalSeconds = ledgers * LEDGER_SECONDS;
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `~${hours} hr${remainingMinutes > 0 ? ` ${remainingMinutes} min` : ''}`;
  const days = Math.floor(hours / 24);
  return `~${days} day${days > 1 ? 's' : ''} ${hours % 24} hr`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toGovernorSettings(form: SettingsForm): GovernorSettings {
  return {
    votingDelay: Number(form.votingDelay),
    votingPeriod: Number(form.votingPeriod),
    quorumNumerator: Number(form.quorumNumerator),
    proposalThreshold: BigInt(form.proposalThreshold || "0"),
    guardian: form.guardian.trim(),
    voteType: form.voteType,
    proposalGracePeriod: Number(form.proposalGracePeriod),
    useDynamicQuorum: form.useDynamicQuorum,
    reflectorOracle: form.reflectorOracle.trim() || null,
    minQuorumUsd: BigInt(form.minQuorumUsd || "0"),
    maxCalldataSize: Number(form.maxCalldataSize),
    proposalCooldown: Number(form.proposalCooldown),
    maxProposalsPerPeriod: Number(form.maxProposalsPerPeriod),
    proposalPeriodDuration: Number(form.proposalPeriodDuration),
  };
}

export default function SettingsPage() {
  const router = useRouter();
  const { isConnected, publicKey } = useWallet();
  const config = useMemo(() => readGovernorConfig(), []);
  const governor = useMemo(
    () => (config ? new GovernorClient(config) : null),
    [config],
  );

  const [currentSettings, setCurrentSettings] = useState<GovernorSettings | null>(null);
  const [form, setForm] = useState<SettingsForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      if (!governor || !config) {
        setLoading(false);
        return;
      }
      try {
        setLoading(true);
        setError(null);
        const settings = await governor.getSettings(publicKey ?? config.governorAddress);
        setCurrentSettings(settings);
        setForm(toForm(settings));
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to load settings");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [governor, config, publicKey]);

  const diffs = useMemo(() => {
    if (!currentSettings || !form) return [];
    const baseline = toForm(currentSettings);
    return (Object.keys(form) as (keyof SettingsForm)[])
      .filter((key) => baseline[key] !== form[key])
      .map((key) => ({
        key,
        from: String(baseline[key]),
        to: String(form[key]),
      }));
  }, [currentSettings, form]);

  async function handleCreateProposal() {
    if (!governor || !config || !form) return;
    try {
      setSubmitting(true);
      setError(null);
      const nextSettings = toGovernorSettings(form);
      const { target, fnName, calldata } = governor.buildUpdateConfigProposal(nextSettings);
      const encodedArg = xdr.ScVal.fromXDR(Buffer.from(calldata));
      const source = publicKey ?? config.governorAddress;
      const simulation = await governor.simulateTargetInvocation(source, target, fnName, [encodedArg]);
      if (!simulation.ok) {
        throw new Error(simulation.error ?? "Simulation failed");
      }

      const q = new URLSearchParams({
        step: "2",
        target,
        fnName,
        calldataHex: toHex(calldata),
        from: "settings",
      });
      router.push(`/propose?${q.toString()}`);
    } catch (e: unknown) {
      setError(
        e instanceof Error ? e.message : "Could not build update_config proposal",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!config) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Configure `NEXT_PUBLIC_GOVERNOR_ADDRESS`, `NEXT_PUBLIC_TIMELOCK_ADDRESS`, and `NEXT_PUBLIC_VOTES_ADDRESS` to use the settings page.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-semibold text-gray-900">Governor settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Review current parameters, prepare changes, and create a prefilled `update_config` proposal.
        </p>
      </div>

      {!isConnected && (
        <p className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
          Read-only mode: connect a wallet to edit settings and create proposals.
        </p>
      )}

      {error && (
        <p className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          {error}
        </p>
      )}

      {loading || !form ? (
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500">
          Loading settings...
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-xl border border-gray-200 bg-white p-5 space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              Parameters
            </h2>

            {(Object.keys(form) as (keyof SettingsForm)[]).map((key) => (
              <label key={key} className="block text-sm">
                <span className="mb-1 block font-medium text-gray-700">{FIELD_LABELS[key]}</span>
                {key === "useDynamicQuorum" ? (
                  <input
                    type="checkbox"
                    checked={form.useDynamicQuorum}
                    disabled={!isConnected}
                    onChange={(e) =>
                      setForm((prev) => (prev ? { ...prev, useDynamicQuorum: e.target.checked } : prev))
                    }
                    className="h-4 w-4 rounded border-gray-300"
                  />
                ) : key === "voteType" ? (
                  <select
                    value={form.voteType}
                    disabled={!isConnected}
                    onChange={(e) =>
                      setForm((prev) =>
                        prev ? { ...prev, voteType: e.target.value as SettingsForm["voteType"] } : prev,
                      )
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm tabular-nums"
                  >
                    <option value="Simple">Simple</option>
                    <option value="Extended">Extended</option>
                    <option value="Quadratic">Quadratic</option>
                  </select>
                ) : (
                  <input
                    type="text"
                    value={form[key] as string}
                    disabled={!isConnected}
                    onChange={(e) =>
                      setForm((prev) => (prev ? { ...prev, [key]: e.target.value } : prev))
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm tabular-nums"
                  />
                )}
              </label>
            ))}

            <button
              type="button"
              onClick={handleCreateProposal}
              disabled={!isConnected || submitting || diffs.length === 0}
              className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Verifying calldata..." : "Create proposal"}
            </button>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5 space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              Rate limits
            </h2>
            {form && (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between items-center py-1.5 border-b border-gray-100 last:border-0">
                  <span className="text-gray-600">Proposal cooldown</span>
                  <span className="font-mono text-gray-900 tabular-nums">
                    {ledgerToTimeEstimate(Number(form.proposalCooldown))} ({form.proposalCooldown} ledgers)
                  </span>
                </div>
                <div className="flex justify-between items-center py-1.5 border-b border-gray-100 last:border-0">
                  <span className="text-gray-600">Max proposals per period</span>
                  <span className="font-mono text-gray-900 tabular-nums">
                    {form.maxProposalsPerPeriod}
                  </span>
                </div>
                <div className="flex justify-between items-center py-1.5">
                  <span className="text-gray-600">Period</span>
                  <span className="font-mono text-gray-900 tabular-nums">
                    {ledgerToTimeEstimate(Number(form.proposalPeriodDuration))} ({form.proposalPeriodDuration} ledgers)
                  </span>
                </div>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 mb-3">
              Diff preview
            </h2>
            {diffs.length === 0 ? (
              <p className="text-sm text-gray-500">No parameter changes yet.</p>
            ) : (
              <ul className="space-y-2">
                {diffs.map((diff) => (
                  <li key={diff.key} className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-sm">
                    <p className="font-medium text-gray-800">{FIELD_LABELS[diff.key]}</p>
                    <p className="font-mono text-xs text-gray-500 tabular-nums">
                      {diff.from} {"->"} {diff.to}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
