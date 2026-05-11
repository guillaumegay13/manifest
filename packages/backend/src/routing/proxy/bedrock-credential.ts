/**
 * Bedrock packs four pieces of state (access key id, secret, optional
 * session token, and AWS region) into the single `api_key_encrypted`
 * column shared with every other provider. The frontend JSON-stringifies
 * a credential object before posting; the backend decrypts the column
 * and parses the JSON here.
 *
 * Region lives inside the credential blob (not the dedicated `region`
 * column) because it's intrinsic to an AWS credential and unique to this
 * provider — keeping it in one place avoids special-casing the existing
 * Qwen region pathway.
 */

export interface BedrockCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}

const AWS_REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;

export function parseBedrockCredential(raw: string): BedrockCredential | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const accessKeyId = obj.accessKeyId;
  const secretAccessKey = obj.secretAccessKey;
  const region = obj.region;
  const sessionToken = obj.sessionToken;
  if (typeof accessKeyId !== 'string' || accessKeyId.length === 0) return null;
  if (typeof secretAccessKey !== 'string' || secretAccessKey.length === 0) return null;
  if (typeof region !== 'string' || !AWS_REGION_RE.test(region)) return null;
  return {
    accessKeyId,
    secretAccessKey,
    region,
    ...(typeof sessionToken === 'string' && sessionToken.length > 0 ? { sessionToken } : {}),
  };
}

export function packBedrockCredential(cred: BedrockCredential): string {
  return JSON.stringify({
    accessKeyId: cred.accessKeyId,
    secretAccessKey: cred.secretAccessKey,
    region: cred.region,
    ...(cred.sessionToken ? { sessionToken: cred.sessionToken } : {}),
  });
}
