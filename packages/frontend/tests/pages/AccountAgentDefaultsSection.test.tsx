import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, cleanup, screen } from '@solidjs/testing-library';

const mockGetDefaults = vi.fn();
const mockUpdateDefaults = vi.fn();
const mockCheckIsSelfHosted = vi.fn();

vi.mock('../../src/services/api/workspace-defaults.js', () => ({
  getWorkspaceDefaults: () => mockGetDefaults(),
  updateWorkspaceDefaults: (...args: unknown[]) => mockUpdateDefaults(...args),
}));
vi.mock('../../src/services/setup-status.js', () => ({
  checkIsSelfHosted: () => mockCheckIsSelfHosted(),
}));

import AccountAgentDefaultsSection from '../../src/pages/AccountAgentDefaultsSection';

const AUTOFIX = 'Auto-fix by default';
const RECORDING = 'Record requests by default';

async function switchFor(label: string): Promise<HTMLButtonElement> {
  return await waitFor(() => {
    const btn = screen.getByLabelText(label) as HTMLButtonElement;
    expect(btn.hasAttribute('disabled')).toBe(false);
    return btn;
  });
}

describe('AccountAgentDefaultsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckIsSelfHosted.mockResolvedValue(false);
    mockGetDefaults.mockResolvedValue({ autofix: null, recording: null });
    mockUpdateDefaults.mockImplementation(async (patch: Partial<Record<string, boolean>>) => ({
      autofix: null,
      recording: null,
      ...patch,
    }));
  });
  afterEach(() => cleanup());

  it('shows the cloud deployment default when no workspace choice is stored', async () => {
    render(() => <AccountAgentDefaultsSection />);
    expect((await switchFor(AUTOFIX)).getAttribute('aria-checked')).toBe('true');
  });

  it('shows Auto-fix off for an unset self-hosted workspace', async () => {
    mockCheckIsSelfHosted.mockResolvedValue(true);
    render(() => <AccountAgentDefaultsSection />);
    expect((await switchFor(AUTOFIX)).getAttribute('aria-checked')).toBe('false');
  });

  it('shows recording on when no workspace choice is stored', async () => {
    render(() => <AccountAgentDefaultsSection />);
    expect((await switchFor(RECORDING)).getAttribute('aria-checked')).toBe('true');
  });

  it('reflects a stored workspace choice over the deployment default', async () => {
    mockGetDefaults.mockResolvedValue({ autofix: false, recording: false });
    render(() => <AccountAgentDefaultsSection />);
    expect((await switchFor(AUTOFIX)).getAttribute('aria-checked')).toBe('false');
    expect((await switchFor(RECORDING)).getAttribute('aria-checked')).toBe('false');
  });

  it('persists an Auto-fix change without a modal in cloud mode', async () => {
    render(() => <AccountAgentDefaultsSection />);
    fireEvent.click(await switchFor(AUTOFIX));
    await waitFor(() => expect(mockUpdateDefaults).toHaveBeenCalledWith({ autofix: false }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('gates enabling Auto-fix behind the consent modal when self-hosted', async () => {
    mockCheckIsSelfHosted.mockResolvedValue(true);
    render(() => <AccountAgentDefaultsSection />);
    fireEvent.click(await switchFor(AUTOFIX));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(mockUpdateDefaults).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Agree & enable Auto-fix'));
    await waitFor(() => expect(mockUpdateDefaults).toHaveBeenCalledWith({ autofix: true }));
  });

  it('cancelling the consent modal stores nothing', async () => {
    mockCheckIsSelfHosted.mockResolvedValue(true);
    render(() => <AccountAgentDefaultsSection />);
    fireEvent.click(await switchFor(AUTOFIX));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mockUpdateDefaults).not.toHaveBeenCalled();
  });

  it('never gates turning Auto-fix off behind the modal', async () => {
    mockCheckIsSelfHosted.mockResolvedValue(true);
    mockGetDefaults.mockResolvedValue({ autofix: true, recording: null });
    render(() => <AccountAgentDefaultsSection />);
    fireEvent.click(await switchFor(AUTOFIX));
    await waitFor(() => expect(mockUpdateDefaults).toHaveBeenCalledWith({ autofix: false }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('persists a recording change with no consent gate', async () => {
    render(() => <AccountAgentDefaultsSection />);
    fireEvent.click(await switchFor(RECORDING));
    await waitFor(() => expect(mockUpdateDefaults).toHaveBeenCalledWith({ recording: false }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the switches usable after a failed save', async () => {
    mockUpdateDefaults.mockRejectedValue(new Error('boom'));
    render(() => <AccountAgentDefaultsSection />);
    fireEvent.click(await switchFor(RECORDING));
    await waitFor(() => expect(mockUpdateDefaults).toHaveBeenCalled());
    // The rejection is swallowed (fetchMutate toasts it), and the control
    // must not be left stuck in the saving state.
    expect((await switchFor(RECORDING)).hasAttribute('disabled')).toBe(false);
  });

  it('disables the switches while the read is failing', async () => {
    mockGetDefaults.mockRejectedValue(new Error('nope'));
    render(() => <AccountAgentDefaultsSection />);
    await waitFor(() => {
      const btn = screen.getByLabelText(RECORDING) as HTMLButtonElement;
      expect(btn.hasAttribute('disabled')).toBe(true);
    });
    expect(mockUpdateDefaults).not.toHaveBeenCalled();
  });
});
