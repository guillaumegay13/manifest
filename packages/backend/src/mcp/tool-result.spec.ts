import { err, ok } from './tool-result';

describe('tool-result', () => {
  it('serializes a payload as a text content block', () => {
    expect(ok({ a: 1 })).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) }],
    });
  });

  it('flags errors so the client renders them as failures', () => {
    expect(err('boom')).toEqual({
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    });
  });
});
