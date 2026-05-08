// Mocks must be declared before importing the module under test so the
// `BedrockRuntimeClient` constructor can be observed.
export {};
const ctorSpy = jest.fn();
jest.mock('@aws-sdk/client-bedrock-runtime', () => {
  const actual = jest.requireActual('@aws-sdk/client-bedrock-runtime');
  return {
    ...actual,
    BedrockRuntimeClient: function MockBedrockRuntimeClient(config: unknown) {
      ctorSpy(config);
      return { __mock: true };
    },
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { defaultBedrockRuntimeClientFactory } = require('./bedrock-transport');

describe('defaultBedrockRuntimeClientFactory', () => {
  beforeEach(() => ctorSpy.mockClear());

  it('passes region and credentials without session token', () => {
    defaultBedrockRuntimeClientFactory('us-east-1', {
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
    });
    expect(ctorSpy).toHaveBeenCalledWith({
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
      },
    });
  });

  it('passes session token when provided', () => {
    defaultBedrockRuntimeClientFactory('eu-west-2', {
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      sessionToken: 'tok',
    });
    expect(ctorSpy).toHaveBeenCalledWith({
      region: 'eu-west-2',
      credentials: {
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
        sessionToken: 'tok',
      },
    });
  });
});
