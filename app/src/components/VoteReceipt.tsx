import { VoteSupport } from "@nebgov/sdk";

interface Props {
  support: VoteSupport;
  weight: bigint;
  reason?: string;
}

const SUPPORT_LABELS: Record<VoteSupport, string> = {
  [VoteSupport.For]: "For",
  [VoteSupport.Against]: "Against",
  [VoteSupport.Abstain]: "Abstain",
};

const SUPPORT_COLORS: Record<VoteSupport, string> = {
  [VoteSupport.For]: "text-emerald-600",
  [VoteSupport.Against]: "text-rose-600",
  [VoteSupport.Abstain]: "text-slate-500",
};

export function VoteReceipt({ support, weight, reason }: Props) {
  return (
    <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
      <p className="text-emerald-800 font-medium">
        Your vote (<span className={SUPPORT_COLORS[support]}>{SUPPORT_LABELS[support]}</span>) has been recorded.
      </p>
      <p className="text-sm text-emerald-700 mt-1">
        Voting power: {(Number(weight) / 1e7).toLocaleString()} NEB
      </p>
      {reason && (
        <p className="text-sm text-emerald-700 mt-1 italic">&quot;{reason}&quot;</p>
      )}
    </div>
  );
}
