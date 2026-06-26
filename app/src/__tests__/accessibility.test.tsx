/**
 * @jest-environment jsdom
 */

import React from 'react';
import { render } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { VotingModal } from '../components/VotingModal';
import { ProposalStateBadge } from '../components/ProposalStateBadge';
import { ProposalState, VoteSupport } from '@nebgov/sdk';

// Extend Jest matchers
expect.extend(toHaveNoViolations);

// Mock the wallet context
jest.mock('../lib/wallet-context', () => ({
  useWallet: () => ({
    isConnected: true,
    connect: jest.fn(),
    publicKey: 'GTEST123...',
  }),
}));

// Mock react-hot-toast
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

describe('Accessibility Tests', () => {
  describe('VotingModal', () => {
    const defaultProps = {
      open: true,
      onClose: jest.fn(),
      proposalId: BigInt(1),
      preselectedSupport: null,
      delegatee: 'GTEST123...',
      votingPower: BigInt(1000000),
      onOpenDelegate: jest.fn(),
      onVoted: jest.fn(),
    };

    it('should not have accessibility violations', async () => {
      const { container } = render(<VotingModal {...defaultProps} />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('should have proper ARIA attributes for modal', () => {
      const { getByRole } = render(<VotingModal {...defaultProps} />);
      
      const dialog = getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(dialog).toHaveAttribute('aria-labelledby', 'voting-modal-title');
      expect(dialog).toHaveAttribute('aria-describedby', 'voting-modal-description');
    });

    it('should have proper form labels and descriptions', () => {
      const { getByLabelText, getByRole } = render(<VotingModal {...defaultProps} />);
      
      // Check textarea has proper label
      const reasonTextarea = getByLabelText(/optional reason/i);
      expect(reasonTextarea).toBeInTheDocument();
      expect(reasonTextarea).toHaveAttribute('aria-describedby', 'reason-help');

      // Check vote options are properly grouped
      const radioGroup = getByRole('radiogroup');
      expect(radioGroup).toHaveAttribute('aria-label', 'Vote options');
    });

    it('should have accessible close button', () => {
      const { getByLabelText } = render(<VotingModal {...defaultProps} />);
      
      const closeButton = getByLabelText(/close voting modal/i);
      expect(closeButton).toBeInTheDocument();
    });

    it('should handle keyboard navigation', () => {
      const { getByRole } = render(<VotingModal {...defaultProps} />);
      
      const dialog = getByRole('dialog');
      expect(dialog).toHaveAttribute('tabIndex', '-1');
    });

    it('should have proper vote button accessibility', () => {
      const { getAllByRole } = render(<VotingModal {...defaultProps} />);
      
      const radioButtons = getAllByRole('radio');
      expect(radioButtons).toHaveLength(3);
      
      radioButtons.forEach((button, index) => {
        const labels = ['Vote For', 'Vote Against', 'Vote Abstain'];
        expect(button).toHaveAttribute('aria-label', labels[index]);
        expect(button).toHaveAttribute('aria-checked');
      });
    });

    it('should provide context for disabled state', () => {
      const propsWithoutDelegatee = {
        ...defaultProps,
        delegatee: null,
      };
      
      const { getByRole } = render(<VotingModal {...propsWithoutDelegatee} />);
      
      const confirmButton = getByRole('button', { name: /confirm & sign/i });
      expect(confirmButton).toBeDisabled();
      expect(confirmButton).toHaveAttribute('aria-describedby', 'delegation-required');
    });
  });

  describe('ProposalStateBadge', () => {
    const STATES = [
      ProposalState.Pending,
      ProposalState.Active,
      ProposalState.Succeeded,
      ProposalState.Defeated,
      ProposalState.Queued,
      ProposalState.Executed,
      ProposalState.Cancelled,
      ProposalState.Expired,
    ];

    it.each(STATES)('renders a visible label for state %s', (state) => {
      const { getByText } = render(<ProposalStateBadge state={state} />);
      expect(getByText(state, { exact: false })).toBeInTheDocument();
    });

    it('should not have accessibility violations for proposal state badges', async () => {
      const { container } = render(
        <div>
          {STATES.map((state) => (
            <ProposalStateBadge key={state} state={state} />
          ))}
        </div>
      );

      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });

  describe('Color Contrast', () => {
    const statusColors: Record<string, { bg: string; text: string }> = {
      Pending: { bg: '#fef3c7', text: '#92400e' },
      Active: { bg: '#dbeafe', text: '#1e40af' },
      Succeeded: { bg: '#dcfce7', text: '#166534' },
      Defeated: { bg: '#fee2e2', text: '#991b1b' },
      Queued: { bg: '#f3e8ff', text: '#6b21a8' },
      Executed: { bg: '#f3e8ff', text: '#6b21a8' },
      Cancelled: { bg: '#f3f4f6', text: '#374151' },
      Expired: { bg: '#fff1f2', text: '#9f1239' },
    };

    const hexToLuminance = (hex: string) => {
      const normalized = hex.replace('#', '');
      const rgb = [0, 1, 2].map((index) => parseInt(normalized.slice(index * 2, index * 2 + 2), 16) / 255);
      const adjusted = rgb.map((channel) => (channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)));
      return 0.2126 * adjusted[0] + 0.7152 * adjusted[1] + 0.0722 * adjusted[2];
    };

    const contrastRatio = (hexA: string, hexB: string) => {
      const lumA = hexToLuminance(hexA);
      const lumB = hexToLuminance(hexB);
      const lighter = Math.max(lumA, lumB);
      const darker = Math.min(lumA, lumB);
      return (lighter + 0.05) / (darker + 0.05);
    };

    it('should meet WCAG AA contrast requirements for status badge text', () => {
      Object.entries(statusColors).forEach(([label, { bg, text }]) => {
        const ratio = contrastRatio(bg, text);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    });
  });
});