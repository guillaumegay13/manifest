import { fetchBedrockModels, type BedrockClientLike } from './bedrock-model-fetcher';
import { packBedrockCredential } from '../routing/proxy/bedrock-credential';

const VALID_CRED = packBedrockCredential({
  accessKeyId: 'AKIA',
  secretAccessKey: 'secret',
  region: 'us-east-1',
});

function fakeClient(
  foundation: unknown,
  profiles: unknown,
  failures: { foundation?: boolean; profiles?: boolean } = {},
): BedrockClientLike {
  return {
    send: jest.fn((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'ListFoundationModelsCommand') {
        if (failures.foundation) return Promise.reject(new Error('foundation 403'));
        return Promise.resolve(foundation);
      }
      if (cmd.constructor.name === 'ListInferenceProfilesCommand') {
        if (failures.profiles) return Promise.reject(new Error('profiles 403'));
        return Promise.resolve(profiles);
      }
      return Promise.reject(new Error(`unexpected: ${cmd.constructor.name}`));
    }),
  } as unknown as BedrockClientLike;
}

describe('fetchBedrockModels', () => {
  it('returns empty list for invalid credentials', async () => {
    const out = await fetchBedrockModels({ apiKey: 'not-json' });
    expect(out).toEqual([]);
  });

  it('filters foundation models to Anthropic vendor', async () => {
    const foundation = {
      modelSummaries: [
        {
          modelId: 'anthropic.claude-3-5-haiku-20241022-v1:0',
          modelName: 'Claude 3.5 Haiku',
          providerName: 'Anthropic',
          inferenceTypesSupported: ['ON_DEMAND'],
          inputModalities: ['TEXT'],
          outputModalities: ['TEXT'],
        },
        {
          modelId: 'meta.llama3-1-8b',
          providerName: 'Meta',
          inferenceTypesSupported: ['ON_DEMAND'],
        },
      ],
    };
    const profiles = { inferenceProfileSummaries: [] };
    const out = await fetchBedrockModels({
      apiKey: VALID_CRED,
      clientFactory: () => fakeClient(foundation, profiles),
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('anthropic.claude-3-5-haiku-20241022-v1:0');
    expect(out[0].displayName).toBe('Claude 3.5 Haiku');
    expect(out[0].provider).toBe('bedrock');
  });

  it('skips PROVISIONED-only foundation models', async () => {
    const foundation = {
      modelSummaries: [
        {
          modelId: 'anthropic.claude-internal',
          providerName: 'Anthropic',
          inferenceTypesSupported: ['PROVISIONED'],
        },
      ],
    };
    const out = await fetchBedrockModels({
      apiKey: VALID_CRED,
      clientFactory: () => fakeClient(foundation, { inferenceProfileSummaries: [] }),
    });
    expect(out).toEqual([]);
  });

  it('infers Anthropic by modelId prefix when providerName is missing', async () => {
    const foundation = {
      modelSummaries: [
        {
          modelId: 'anthropic.claude-no-vendor',
          // no providerName
        },
      ],
    };
    const out = await fetchBedrockModels({
      apiKey: VALID_CRED,
      clientFactory: () => fakeClient(foundation, { inferenceProfileSummaries: [] }),
    });
    expect(out.map((m) => m.id)).toEqual(['anthropic.claude-no-vendor']);
  });

  it('rejects non-text foundation models', async () => {
    const foundation = {
      modelSummaries: [
        {
          modelId: 'anthropic.embedding-only',
          providerName: 'Anthropic',
          inferenceTypesSupported: ['ON_DEMAND'],
          outputModalities: ['EMBEDDING'],
        },
      ],
    };
    const out = await fetchBedrockModels({
      apiKey: VALID_CRED,
      clientFactory: () => fakeClient(foundation, { inferenceProfileSummaries: [] }),
    });
    expect(out).toEqual([]);
  });

  it('rejects non-text input modalities', async () => {
    const foundation = {
      modelSummaries: [
        {
          modelId: 'anthropic.audio-only',
          providerName: 'Anthropic',
          inferenceTypesSupported: ['ON_DEMAND'],
          inputModalities: ['AUDIO'],
        },
      ],
    };
    const out = await fetchBedrockModels({
      apiKey: VALID_CRED,
      clientFactory: () => fakeClient(foundation, { inferenceProfileSummaries: [] }),
    });
    expect(out).toEqual([]);
  });

  it('includes Anthropic inference profiles', async () => {
    const profiles = {
      inferenceProfileSummaries: [
        {
          inferenceProfileId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
          inferenceProfileName: 'Claude 3.5 Sonnet (US)',
        },
        {
          inferenceProfileId: 'eu.meta.llama3-405b',
        },
      ],
    };
    const out = await fetchBedrockModels({
      apiKey: VALID_CRED,
      clientFactory: () => fakeClient({ modelSummaries: [] }, profiles),
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('us.anthropic.claude-3-5-sonnet-20241022-v2:0');
  });

  it('dedupes models that appear in both lists', async () => {
    const id = 'anthropic.claude-3-5-haiku-20241022-v1:0';
    const foundation = {
      modelSummaries: [
        {
          modelId: id,
          modelName: 'Foundation Name',
          providerName: 'Anthropic',
          inferenceTypesSupported: ['ON_DEMAND'],
        },
      ],
    };
    const profiles = {
      inferenceProfileSummaries: [{ inferenceProfileId: id, inferenceProfileName: 'Profile Name' }],
    };
    const out = await fetchBedrockModels({
      apiKey: VALID_CRED,
      clientFactory: () => fakeClient(foundation, profiles),
    });
    expect(out).toHaveLength(1);
    // Profile entries arrive after foundation entries, so they overwrite.
    expect(out[0].displayName).toBe('Profile Name');
  });

  it('returns empty list when both APIs fail', async () => {
    const out = await fetchBedrockModels({
      apiKey: VALID_CRED,
      clientFactory: () => fakeClient(undefined, undefined, { foundation: true, profiles: true }),
    });
    expect(out).toEqual([]);
  });

  it('returns partial list when one API fails', async () => {
    const profiles = {
      inferenceProfileSummaries: [
        { inferenceProfileId: 'us.anthropic.claude-only', inferenceProfileName: 'Sonnet' },
      ],
    };
    const out = await fetchBedrockModels({
      apiKey: VALID_CRED,
      clientFactory: () => fakeClient(undefined, profiles, { foundation: true }),
    });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('us.anthropic.claude-only');
  });

  it('skips entries with missing model IDs', async () => {
    const foundation = {
      modelSummaries: [
        { modelId: undefined, providerName: 'Anthropic', inferenceTypesSupported: ['ON_DEMAND'] },
      ],
    };
    const profiles = {
      inferenceProfileSummaries: [{ inferenceProfileId: undefined }],
    };
    const out = await fetchBedrockModels({
      apiKey: VALID_CRED,
      clientFactory: () => fakeClient(foundation, profiles),
    });
    expect(out).toEqual([]);
  });

  it('falls back to model id for displayName when name is missing', async () => {
    const foundation = {
      modelSummaries: [
        {
          modelId: 'anthropic.claude-no-name',
          providerName: 'Anthropic',
          inferenceTypesSupported: ['ON_DEMAND'],
        },
      ],
    };
    const profiles = {
      inferenceProfileSummaries: [{ inferenceProfileId: 'us.anthropic.claude-anon' }],
    };
    const out = await fetchBedrockModels({
      apiKey: VALID_CRED,
      clientFactory: () => fakeClient(foundation, profiles),
    });
    const ids = out.map((m) => `${m.id}|${m.displayName}`);
    expect(ids).toEqual(
      expect.arrayContaining([
        'anthropic.claude-no-name|anthropic.claude-no-name',
        'us.anthropic.claude-anon|us.anthropic.claude-anon',
      ]),
    );
  });

  it('treats foundation entries with no inferenceTypesSupported as on-demand-eligible', async () => {
    const foundation = {
      modelSummaries: [
        {
          modelId: 'anthropic.claude-legacy',
          providerName: 'Anthropic',
          // no inferenceTypesSupported field
        },
      ],
    };
    const out = await fetchBedrockModels({
      apiKey: VALID_CRED,
      clientFactory: () => fakeClient(foundation, { inferenceProfileSummaries: [] }),
    });
    expect(out.map((m) => m.id)).toEqual(['anthropic.claude-legacy']);
  });
});
