import { ProposalState } from "@nebgov/sdk";

const STATE_CONFIG: Record<ProposalState, { color: string; icon: string; label: string }> = {
  [ProposalState.Pending]: { color: "bg-yellow-100 text-yellow-800 border border-yellow-200", icon: '⏳', label: 'Pending' },
  [ProposalState.Active]: { color: "bg-blue-100 text-blue-800 border border-blue-200", icon: '●', label: 'Active' },
  [ProposalState.Succeeded]: { color: "bg-green-100 text-green-800 border border-green-200", icon: '✓', label: 'Succeeded' },
  [ProposalState.Defeated]: { color: "bg-red-100 text-red-800 border border-red-200", icon: '✕', label: 'Defeated' },
  [ProposalState.Queued]: { color: "bg-purple-100 text-purple-800 border border-purple-200", icon: '⏳', label: 'Queued' },
  [ProposalState.Executed]: { color: "bg-purple-100 text-purple-800 border border-purple-200", icon: '✅', label: 'Executed' },
  [ProposalState.Cancelled]: { color: "bg-gray-100 text-gray-700 border border-gray-200", icon: '⊘', label: 'Cancelled' },
  [ProposalState.Expired]: { color: "bg-rose-100 text-rose-800 border border-rose-200", icon: '⌛', label: 'Expired' },
};

interface Props {
  state: ProposalState;
}

export function ProposalStateBadge({ state }: Props) {
  const meta = STATE_CONFIG[state];

  return (
    <span className={`px-3 py-1 rounded-full text-xs font-medium ${meta.color}`}>
      {meta.icon} {meta.label}
    </span>
  );
}
