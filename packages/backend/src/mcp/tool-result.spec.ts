import { err, ok, result } from './tool-result';

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

  it('wraps a resolved promise and a rejected Error', async () => {
    await expect(result(Promise.resolve({ a: 1 }))).resolves.toMatchObject({
      content: [{ type: 'text' }],
    });
    await expect(result(Promise.reject(new Error('nope')))).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'nope' }],
    });
  });

  it('stringifies a non-Error rejection', async () => {
    await expect(result(Promise.reject('plain'))).resolves.toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'plain' }],
    });
  });
});
