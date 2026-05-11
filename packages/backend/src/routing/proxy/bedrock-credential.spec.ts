import { packBedrockCredential, parseBedrockCredential } from './bedrock-credential';

describe('parseBedrockCredential', () => {
  const valid = {
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'secret-value',
    region: 'us-east-1',
  };

  it('parses a valid credential without session token', () => {
    const cred = parseBedrockCredential(JSON.stringify(valid));
    expect(cred).toEqual(valid);
  });

  it('parses a credential with a session token', () => {
    const cred = parseBedrockCredential(JSON.stringify({ ...valid, sessionToken: 'fed-token' }));
    expect(cred).toEqual({ ...valid, sessionToken: 'fed-token' });
  });

  it('drops empty session token', () => {
    const cred = parseBedrockCredential(JSON.stringify({ ...valid, sessionToken: '' }));
    expect(cred?.sessionToken).toBeUndefined();
  });

  it('returns null for empty input', () => {
    expect(parseBedrockCredential('')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseBedrockCredential('not json')).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    expect(parseBedrockCredential('"foo"')).toBeNull();
    expect(parseBedrockCredential('null')).toBeNull();
    expect(parseBedrockCredential('123')).toBeNull();
  });

  it('returns null when accessKeyId is missing or empty', () => {
    expect(parseBedrockCredential(JSON.stringify({ ...valid, accessKeyId: '' }))).toBeNull();
    expect(
      parseBedrockCredential(JSON.stringify({ secretAccessKey: 'x', region: 'us-east-1' })),
    ).toBeNull();
  });

  it('returns null when secretAccessKey is missing', () => {
    expect(
      parseBedrockCredential(JSON.stringify({ accessKeyId: 'a', region: 'us-east-1' })),
    ).toBeNull();
  });

  it('returns null when region is missing or malformed', () => {
    expect(parseBedrockCredential(JSON.stringify({ ...valid, region: '' }))).toBeNull();
    expect(parseBedrockCredential(JSON.stringify({ ...valid, region: 'mars-1' }))).toBeNull();
    expect(parseBedrockCredential(JSON.stringify({ ...valid, region: 123 }))).toBeNull();
  });

  it('rejects non-string accessKeyId / secretAccessKey', () => {
    expect(parseBedrockCredential(JSON.stringify({ ...valid, accessKeyId: 5 }))).toBeNull();
    expect(parseBedrockCredential(JSON.stringify({ ...valid, secretAccessKey: 5 }))).toBeNull();
  });
});

describe('packBedrockCredential', () => {
  it('round-trips through parse', () => {
    const cred = {
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      region: 'eu-west-2',
      sessionToken: 'st',
    };
    const packed = packBedrockCredential(cred);
    expect(parseBedrockCredential(packed)).toEqual(cred);
  });

  it('omits sessionToken when not provided', () => {
    const packed = packBedrockCredential({
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      region: 'eu-west-2',
    });
    const obj = JSON.parse(packed);
    expect(obj.sessionToken).toBeUndefined();
  });
});
