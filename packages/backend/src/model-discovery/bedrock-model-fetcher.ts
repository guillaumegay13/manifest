/**
 * Bedrock model discovery.
 *
 * Hits two Bedrock control-plane APIs and merges the results:
 *  - ListFoundationModels  → legacy on-demand model IDs (e.g. `anthropic.claude-3-5-haiku-20241022-v1:0`)
 *  - ListInferenceProfiles → cross-region inference profiles (e.g. `us.anthropic.claude-3-5-sonnet-20241022-v2:0`)
 *
 * Anthropic's newer models on Bedrock can ONLY be invoked through the
 * cross-region inference profile IDs, so omitting them would silently
 * exclude the most recent Claude releases. We filter both lists to
 * Anthropic-vendor entries and dedupe by ID, returning everything as
 * `DiscoveredModel` records ready for the existing pricing-enrichment
 * pipeline.
 */

import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type FoundationModelSummary,
  type InferenceProfileSummary,
  type ListFoundationModelsCommandOutput,
  type ListInferenceProfilesCommandOutput,
} from '@aws-sdk/client-bedrock';

import type { DiscoveredModel } from './model-fetcher';
import {
  parseBedrockCredential,
  type BedrockCredential,
} from '../routing/proxy/bedrock-credential';

const ANTHROPIC_PROVIDER_NAME = 'Anthropic';
const ANTHROPIC_MODEL_PREFIX_RE = /(?:^|\.)anthropic\./i;
const ANTHROPIC_DEFAULT_CONTEXT = 200000;

export interface BedrockClientLike {
  send(command: ListFoundationModelsCommand): Promise<ListFoundationModelsCommandOutput>;
  send(command: ListInferenceProfilesCommand): Promise<ListInferenceProfilesCommandOutput>;
}

export type BedrockClientFactory = (cred: BedrockCredential) => BedrockClientLike;

export const defaultBedrockControlClientFactory: BedrockClientFactory = (cred) =>
  new BedrockClient({
    region: cred.region,
    credentials: {
      accessKeyId: cred.accessKeyId,
      secretAccessKey: cred.secretAccessKey,
      ...(cred.sessionToken ? { sessionToken: cred.sessionToken } : {}),
    },
  });

function isAnthropicFoundation(m: FoundationModelSummary): boolean {
  if (m.providerName === ANTHROPIC_PROVIDER_NAME) return true;
  return typeof m.modelId === 'string' && ANTHROPIC_MODEL_PREFIX_RE.test(m.modelId);
}

function isOnDemandText(m: FoundationModelSummary): boolean {
  const inputs = m.inputModalities ?? [];
  const outputs = m.outputModalities ?? [];
  // Bedrock treats text-modality as default; some embedding-only models exist.
  if (outputs.length > 0 && !outputs.some((o) => String(o).toUpperCase() === 'TEXT')) return false;
  if (inputs.length > 0 && !inputs.some((o) => String(o).toUpperCase() === 'TEXT')) return false;
  const types = m.inferenceTypesSupported ?? [];
  // Models without an explicit inference type still typically support
  // direct invocation; only skip when the list exists and excludes
  // ON_DEMAND (e.g. PROVISIONED-only).
  if (types.length === 0) return true;
  return types.some((t) => String(t).toUpperCase() === 'ON_DEMAND');
}

function foundationToDiscovered(m: FoundationModelSummary): DiscoveredModel | null {
  if (!m.modelId) return null;
  return {
    id: m.modelId,
    displayName: m.modelName ?? m.modelId,
    provider: 'bedrock',
    contextWindow: ANTHROPIC_DEFAULT_CONTEXT,
    inputPricePerToken: null,
    outputPricePerToken: null,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore: 3,
  };
}

function isAnthropicProfile(p: InferenceProfileSummary): boolean {
  if (typeof p.inferenceProfileId !== 'string') return false;
  return ANTHROPIC_MODEL_PREFIX_RE.test(p.inferenceProfileId);
}

function profileToDiscovered(p: InferenceProfileSummary): DiscoveredModel | null {
  if (!p.inferenceProfileId) return null;
  return {
    id: p.inferenceProfileId,
    displayName: p.inferenceProfileName ?? p.inferenceProfileId,
    provider: 'bedrock',
    contextWindow: ANTHROPIC_DEFAULT_CONTEXT,
    inputPricePerToken: null,
    outputPricePerToken: null,
    capabilityReasoning: false,
    capabilityCode: false,
    qualityScore: 3,
  };
}

export interface FetchBedrockModelsOptions {
  apiKey: string;
  clientFactory?: BedrockClientFactory;
}

export async function fetchBedrockModels(
  opts: FetchBedrockModelsOptions,
): Promise<DiscoveredModel[]> {
  const cred = parseBedrockCredential(opts.apiKey);
  if (!cred) return [];

  const factory = opts.clientFactory ?? defaultBedrockControlClientFactory;
  const client = factory(cred);

  const [foundationOut, profilesOut] = await Promise.all([
    client.send(new ListFoundationModelsCommand({})).catch(() => null),
    client
      .send(new ListInferenceProfilesCommand({ typeEquals: 'SYSTEM_DEFINED' }))
      .catch(() => null),
  ]);

  const merged = new Map<string, DiscoveredModel>();

  for (const m of foundationOut?.modelSummaries ?? []) {
    if (!isAnthropicFoundation(m) || !isOnDemandText(m)) continue;
    const d = foundationToDiscovered(m);
    if (d) merged.set(d.id, d);
  }

  for (const p of profilesOut?.inferenceProfileSummaries ?? []) {
    if (!isAnthropicProfile(p)) continue;
    const d = profileToDiscovered(p);
    if (d) merged.set(d.id, d);
  }

  return Array.from(merged.values());
}
