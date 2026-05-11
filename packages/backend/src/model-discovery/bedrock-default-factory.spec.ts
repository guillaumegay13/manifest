export {};
const ctorSpy = jest.fn();
jest.mock('@aws-sdk/client-bedrock', () => {
  const actual = jest.requireActual('@aws-sdk/client-bedrock');
  return {
    ...actual,
    BedrockClient: function MockBedrockClient(config: unknown) {
      ctorSpy(config);
      return { __mock: true };
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { defaultBedrockControlClientFactory } = require('./bedrock-model-fetcher');

describe('defaultBedrockControlClientFactory', () => {
  beforeEach(() => ctorSpy.mockClear());

  it('passes region and credentials without session token', () => {
    defaultBedrockControlClientFactory({
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      region: 'ap-southeast-2',
    });
    expect(ctorSpy).toHaveBeenCalledWith({
      region: 'ap-southeast-2',
      credentials: {
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
      },
    });
  });

  it('passes session token when provided', () => {
    defaultBedrockControlClientFactory({
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      sessionToken: 'tok',
      region: 'us-west-2',
    });
    expect(ctorSpy).toHaveBeenCalledWith({
      region: 'us-west-2',
      credentials: {
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
        sessionToken: 'tok',
      },
    });
  });
});
