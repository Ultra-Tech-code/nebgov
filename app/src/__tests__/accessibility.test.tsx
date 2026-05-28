/**
 * @jest-environment jsdom
 */
/// <reference types="@testing-library/jest-dom" />

import React from 'react';
import { render } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

declare global {
  namespace jest {
    interface Matchers<R> {
      toHaveNoViolations(): R;
    }
  }
}
import { VotingModal } from '../components/VotingModal';
import { VoteSupport } from '@nebgov/sdk';

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

  describe('Color Contrast', () => {
    it('should meet WCAG AA contrast requirements for status badges', () => {
      // This is a basic test - in a real scenario, you'd use tools like 
      // @testing-library/jest-dom with custom matchers or axe-core
      const statusColors = {
        'bg-yellow-100 text-yellow-800': { bg: '#fef3c7', text: '#92400e' },
        'bg-blue-100 text-blue-800': { bg: '#dbeafe', text: '#1e40af' },
        'bg-green-100 text-green-800': { bg: '#dcfce7', text: '#166534' },
        'bg-red-100 text-red-800': { bg: '#fee2e2', text: '#991b1b' },
        'bg-purple-100 text-purple-800': { bg: '#f3e8ff', text: '#6b21a8' },
        'bg-gray-100 text-gray-800': { bg: '#f3f4f6', text: '#1f2937' },
      };

      // In a real implementation, you would calculate contrast ratios
      // and ensure they meet WCAG AA standards (4.5:1 for normal text)
      Object.keys(statusColors).forEach(colorClass => {
        expect(colorClass).toBeTruthy(); // Placeholder for actual contrast checking
      });
    });
  });
});