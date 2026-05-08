import { For, Show, createSignal, type Accessor, type Component, type Setter } from 'solid-js';
import type { ProviderDef } from '../services/providers.js';
import { connectProvider, disconnectProvider } from '../services/api.js';
import { toast } from '../services/toast-store.js';

const AWS_REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;
const REGION_FIELD_ID = 'region';

export interface BedrockCredentialState {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  region: string;
}

const EMPTY_CREDENTIAL: BedrockCredentialState = {
  accessKeyId: '',
  secretAccessKey: '',
  sessionToken: '',
  region: '',
};

export function packBedrockCredentialPayload(state: BedrockCredentialState): string {
  const payload: Record<string, string> = {
    accessKeyId: state.accessKeyId.trim(),
    secretAccessKey: state.secretAccessKey.trim(),
    region: state.region.trim(),
  };
  const sessionToken = state.sessionToken.trim();
  if (sessionToken.length > 0) payload.sessionToken = sessionToken;
  return JSON.stringify(payload);
}

export function validateBedrockCredential(state: BedrockCredentialState): string | null {
  if (!state.accessKeyId.trim()) return 'Access Key ID is required';
  if (!state.secretAccessKey.trim()) return 'Secret Access Key is required';
  const region = state.region.trim();
  if (!region) return 'Region is required';
  if (!AWS_REGION_RE.test(region)) {
    return 'Region must look like "us-east-1" or "eu-west-2"';
  }
  return null;
}

export interface BedrockKeyFormProps {
  provDef: ProviderDef;
  provId: string;
  agentName: string;
  connected: Accessor<boolean>;
  busy: Accessor<boolean>;
  setBusy: Setter<boolean>;
  onBack: () => void;
  onUpdate: () => void;
}

const BedrockKeyForm: Component<BedrockKeyFormProps> = (props) => {
  const [state, setState] = createSignal<BedrockCredentialState>({ ...EMPTY_CREDENTIAL });
  const [error, setError] = createSignal<string | null>(null);

  const updateField = (id: string, value: string) => {
    setState((prev) => ({ ...prev, [id]: value }));
    setError(null);
  };

  const handleConnect = async () => {
    const current = state();
    const validation = validateBedrockCredential(current);
    if (validation) {
      setError(validation);
      return;
    }

    props.setBusy(true);
    try {
      await connectProvider(props.agentName, {
        provider: props.provId,
        apiKey: packBedrockCredentialPayload(current),
        authType: 'api_key',
      });
      toast.success(`${props.provDef.name} connected`);
      setState({ ...EMPTY_CREDENTIAL });
      props.onBack();
      props.onUpdate();
    } catch {
      // toast surfaced inside fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    props.setBusy(true);
    try {
      await disconnectProvider(props.agentName, props.provId, 'api_key');
      props.onBack();
      props.onUpdate();
    } catch {
      // toast surfaced inside fetchMutate
    } finally {
      props.setBusy(false);
    }
  };

  return (
    <Show
      when={!props.connected()}
      fallback={
        <button
          class="btn btn--outline provider-detail__action provider-detail__disconnect"
          disabled={props.busy()}
          onClick={handleDisconnect}
        >
          <Show when={!props.busy()} fallback={<span class="spinner" />}>
            Disconnect
          </Show>
        </button>
      }
    >
      <For each={props.provDef.credentialFields ?? []}>
        {(field) => (
          <div class="provider-detail__field">
            <label class="provider-detail__label" for={`bedrock-field-${field.id}`}>
              {field.label}
            </label>
            <input
              id={`bedrock-field-${field.id}`}
              class="provider-detail__input"
              classList={{ 'provider-detail__input--masked': field.secret === true }}
              type={field.secret ? 'password' : 'text'}
              autocomplete="off"
              placeholder={field.placeholder ?? ''}
              aria-label={`${props.provDef.name} ${field.label}`}
              value={state()[field.id as keyof BedrockCredentialState] ?? ''}
              onInput={(e) => updateField(field.id, e.currentTarget.value)}
            />
          </div>
        )}
      </For>
      <div class="provider-detail__field">
        <label class="provider-detail__label" for="bedrock-field-region">
          AWS Region
        </label>
        <input
          id="bedrock-field-region"
          class="provider-detail__input"
          type="text"
          autocomplete="off"
          placeholder="us-east-1"
          aria-label={`${props.provDef.name} AWS Region`}
          value={state().region}
          onInput={(e) => updateField(REGION_FIELD_ID, e.currentTarget.value)}
        />
      </div>
      <Show when={error()}>
        <div class="provider-detail__error" role="alert">
          {error()}
        </div>
      </Show>
      <button
        class="btn btn--primary provider-detail__action"
        disabled={props.busy()}
        onClick={() => void handleConnect()}
      >
        <Show when={!props.busy()} fallback={<span class="spinner" />}>
          Connect
        </Show>
      </button>
    </Show>
  );
};

export default BedrockKeyForm;
