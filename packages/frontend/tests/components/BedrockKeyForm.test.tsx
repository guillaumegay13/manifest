import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockToastError = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock('../../src/services/api.js', () => ({
  connectProvider: (...a: unknown[]) => mockConnect(...a),
  disconnectProvider: (...a: unknown[]) => mockDisconnect(...a),
}));

vi.mock('../../src/services/toast-store.js', () => ({
  toast: {
    error: (...a: unknown[]) => mockToastError(...a),
    success: (...a: unknown[]) => mockToastSuccess(...a),
  },
}));

import BedrockKeyForm, {
  packBedrockCredentialPayload,
  validateBedrockCredential,
} from '../../src/components/BedrockKeyForm';
import type { ProviderDef } from '../../src/services/providers.js';

const PROV: ProviderDef = {
  id: 'bedrock',
  name: 'AWS Bedrock',
  color: '#ff9900',
  initial: 'AB',
  subtitle: '',
  models: [],
  keyPrefix: '',
  minKeyLength: 16,
  keyPlaceholder: 'AKIA...',
  credentialFields: [
    { id: 'accessKeyId', label: 'Access Key ID', placeholder: 'AKIA...', required: true },
    { id: 'secretAccessKey', label: 'Secret Access Key', secret: true, required: true },
    { id: 'sessionToken', label: 'Session Token (optional)', secret: true },
  ],
};

function renderForm(connected = false) {
  const [busy, setBusy] = createSignal(false);
  const onBack = vi.fn();
  const onUpdate = vi.fn();
  const utils = render(() => (
    <BedrockKeyForm
      provDef={PROV}
      provId="bedrock"
      agentName="test"
      connected={() => connected}
      busy={busy}
      setBusy={setBusy}
      onBack={onBack}
      onUpdate={onUpdate}
    />
  ));
  return { ...utils, onBack, onUpdate };
}

describe('packBedrockCredentialPayload', () => {
  it('includes only non-empty session tokens', () => {
    const json = JSON.parse(
      packBedrockCredentialPayload({
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
        region: 'us-east-1',
        sessionToken: '',
      }),
    );
    expect(json.sessionToken).toBeUndefined();
  });

  it('preserves session token when provided', () => {
    const json = JSON.parse(
      packBedrockCredentialPayload({
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
        region: 'us-east-1',
        sessionToken: 'tok',
      }),
    );
    expect(json.sessionToken).toBe('tok');
  });
});

describe('validateBedrockCredential', () => {
  it('returns null for a valid credential', () => {
    expect(
      validateBedrockCredential({
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
        region: 'us-east-1',
        sessionToken: '',
      }),
    ).toBeNull();
  });

  it('flags missing access key', () => {
    expect(
      validateBedrockCredential({
        accessKeyId: '',
        secretAccessKey: 'secret',
        region: 'us-east-1',
        sessionToken: '',
      }),
    ).toMatch(/Access Key ID/);
  });

  it('flags missing secret', () => {
    expect(
      validateBedrockCredential({
        accessKeyId: 'a',
        secretAccessKey: '',
        region: 'us-east-1',
        sessionToken: '',
      }),
    ).toMatch(/Secret Access Key/);
  });

  it('flags missing region', () => {
    expect(
      validateBedrockCredential({
        accessKeyId: 'a',
        secretAccessKey: 'b',
        region: '',
        sessionToken: '',
      }),
    ).toMatch(/Region is required/);
  });

  it('flags malformed region', () => {
    expect(
      validateBedrockCredential({
        accessKeyId: 'a',
        secretAccessKey: 'b',
        region: 'mars-1',
        sessionToken: '',
      }),
    ).toMatch(/us-east-1/);
  });
});

describe('BedrockKeyForm', () => {
  beforeEach(() => {
    mockConnect.mockReset();
    mockDisconnect.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
  });

  it('renders one input per credential field plus a region input', () => {
    renderForm(false);
    expect(screen.getByLabelText(/AWS Bedrock Access Key ID/i)).toBeDefined();
    expect(screen.getByLabelText(/AWS Bedrock Secret Access Key/i)).toBeDefined();
    expect(screen.getByLabelText(/AWS Bedrock Session Token/i)).toBeDefined();
    expect(screen.getByLabelText(/AWS Bedrock AWS Region/i)).toBeDefined();
  });

  it('shows a validation error when fields are missing on connect', async () => {
    renderForm(false);
    fireEvent.click(screen.getByRole('button', { name: /Connect/i }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('clears the validation error when the user types', async () => {
    renderForm(false);
    fireEvent.click(screen.getByRole('button', { name: /Connect/i }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeDefined());
    fireEvent.input(screen.getByLabelText(/Access Key ID/i), { target: { value: 'AKIA' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('packs the credential and calls connectProvider', async () => {
    mockConnect.mockResolvedValue(undefined);
    const { onBack, onUpdate } = renderForm(false);
    fireEvent.input(screen.getByLabelText(/Access Key ID/i), { target: { value: 'AKIA' } });
    fireEvent.input(screen.getByLabelText(/Secret Access Key/i), { target: { value: 'secret' } });
    fireEvent.input(screen.getByLabelText(/AWS Region/i), { target: { value: 'us-east-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Connect/i }));

    await waitFor(() => expect(mockConnect).toHaveBeenCalled());
    const [, body] = mockConnect.mock.calls[0];
    expect(body.provider).toBe('bedrock');
    expect(body.authType).toBe('api_key');
    const apiKey = JSON.parse(body.apiKey);
    expect(apiKey).toEqual({
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      region: 'us-east-1',
    });
    expect(mockToastSuccess).toHaveBeenCalled();
    expect(onBack).toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalled();
  });

  it('swallows connect errors silently (toast surfaced upstream)', async () => {
    mockConnect.mockRejectedValue(new Error('forbidden'));
    const { onBack } = renderForm(false);
    fireEvent.input(screen.getByLabelText(/Access Key ID/i), { target: { value: 'AKIA' } });
    fireEvent.input(screen.getByLabelText(/Secret Access Key/i), { target: { value: 'secret' } });
    fireEvent.input(screen.getByLabelText(/AWS Region/i), { target: { value: 'us-east-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Connect/i }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalled());
    expect(onBack).not.toHaveBeenCalled();
  });

  it('renders a Disconnect button when connected', () => {
    renderForm(true);
    expect(screen.getByRole('button', { name: /Disconnect/i })).toBeDefined();
  });

  it('calls disconnectProvider when Disconnect clicked', async () => {
    mockDisconnect.mockResolvedValue(undefined);
    const { onBack, onUpdate } = renderForm(true);
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/i }));
    await waitFor(() => expect(mockDisconnect).toHaveBeenCalledWith('test', 'bedrock', 'api_key'));
    expect(onBack).toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalled();
  });

  it('swallows disconnect errors silently', async () => {
    mockDisconnect.mockRejectedValue(new Error('forbidden'));
    const { onBack } = renderForm(true);
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/i }));
    await waitFor(() => expect(mockDisconnect).toHaveBeenCalled());
    expect(onBack).not.toHaveBeenCalled();
  });

  it('renders without credential fields gracefully', () => {
    const noFields: ProviderDef = { ...PROV, credentialFields: undefined };
    const [busy, setBusy] = createSignal(false);
    render(() => (
      <BedrockKeyForm
        provDef={noFields}
        provId="bedrock"
        agentName="t"
        connected={() => false}
        busy={busy}
        setBusy={setBusy}
        onBack={vi.fn()}
        onUpdate={vi.fn()}
      />
    ));
    // Region input is always rendered, even without credentialFields.
    expect(screen.getByLabelText(/AWS Region/i)).toBeDefined();
  });
});
