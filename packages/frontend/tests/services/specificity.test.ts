import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getSpecificityAssignments,
  toggleSpecificity,
  overrideSpecificity,
  resetSpecificity,
  resetAllSpecificity,
} from '../../src/services/api.js';

vi.mock('../../src/services/toast-store.js', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  vi.stubGlobal('location', { origin: 'http://localhost:3000' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockOk(body: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(body),
  });
}

function mockMutateOk(body?: unknown) {
  const text = body !== undefined ? JSON.stringify(body) : '';
  mockFetch.mockResolvedValueOnce({
    ok: true,
    text: () => Promise.resolve(text),
  });
}

const assignment = {
  id: 'assign-1',
  agent_id: 'agent-1',
  category: 'code_generation',
  is_active: true,
  override_route: null,
  auto_assigned_route: {
    provider: 'anthropic',
    authType: 'api_key' as const,
    model: 'claude-sonnet-4-20250514',
  },
  fallback_routes: null,
  updated_at: '2026-04-09T00:00:00Z',
};

describe('getSpecificityAssignments', () => {
  it('should fetch assignments with correct URL and credentials', async () => {
    mockOk([assignment]);

    const result = await getSpecificityAssignments('my-agent');

    expect(result).toEqual([assignment]);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/routing/my-agent/specificity',
      { credentials: 'include', cache: 'no-store' },
    );
  });

  it('should encode special characters in agent name', async () => {
    mockOk([]);

    await getSpecificityAssignments('agent/with spaces');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/routing/agent%2Fwith%20spaces/specificity',
      { credentials: 'include', cache: 'no-store' },
    );
  });
});

describe('toggleSpecificity', () => {
  it('should POST with active flag set to true', async () => {
    mockMutateOk(assignment);

    const result = await toggleSpecificity('my-agent', 'code_generation', true);

    expect(result).toEqual(assignment);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/routing/my-agent/specificity/code_generation/toggle',
      {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      },
    );
  });

  it('should POST with active flag set to false', async () => {
    mockMutateOk(assignment);

    await toggleSpecificity('my-agent', 'code_generation', false);

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/routing/my-agent/specificity/code_generation/toggle',
      {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false }),
      },
    );
  });

  it('should encode special characters in agent name and category', async () => {
    mockMutateOk(assignment);

    await toggleSpecificity('agent/name', 'cat/egory', true);

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/routing/agent%2Fname/specificity/cat%2Fegory/toggle',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('overrideSpecificity', () => {
  it('should PUT with route', async () => {
    const route = { provider: 'openai', authType: 'api_key' as const, model: 'gpt-4o' };
    const overridden = { ...assignment, override_route: route };
    mockMutateOk(overridden);

    const result = await overrideSpecificity('my-agent', 'code_generation', route);

    expect(result).toEqual(overridden);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/routing/my-agent/specificity/code_generation',
      {
        credentials: 'include',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route }),
      },
    );
  });

  it('should include authType in the route body', async () => {
    const route = { provider: 'openai', authType: 'subscription' as const, model: 'gpt-4o' };
    mockMutateOk(assignment);

    await overrideSpecificity('my-agent', 'code_generation', route);

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/routing/my-agent/specificity/code_generation',
      {
        credentials: 'include',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route }),
      },
    );
  });

  it('should send local authType in the route body', async () => {
    const route = { provider: 'ollama', authType: 'local' as const, model: 'llama3.1:8b' };
    mockMutateOk(assignment);

    await overrideSpecificity('my-agent', 'code_generation', route);

    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({ route });
  });

  it('should encode special characters in agent name and category', async () => {
    mockMutateOk(assignment);

    await overrideSpecificity('a b', 'c d', {
      provider: 'provider',
      authType: 'api_key',
      model: 'model',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/routing/a%20b/specificity/c%20d',
      expect.objectContaining({ method: 'PUT' }),
    );
  });
});

describe('resetSpecificity', () => {
  it('should send DELETE request with correct URL', async () => {
    mockMutateOk();

    await resetSpecificity('my-agent', 'code_generation');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/routing/my-agent/specificity/code_generation',
      { credentials: 'include', method: 'DELETE' },
    );
  });

  it('should encode special characters in agent name and category', async () => {
    mockMutateOk();

    await resetSpecificity('agent/name', 'cat/egory');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/routing/agent%2Fname/specificity/cat%2Fegory',
      { credentials: 'include', method: 'DELETE' },
    );
  });
});

describe('resetAllSpecificity', () => {
  it('should send POST request to reset-all endpoint', async () => {
    mockMutateOk();

    await resetAllSpecificity('my-agent');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/routing/my-agent/specificity/reset-all',
      { credentials: 'include', method: 'POST' },
    );
  });

  it('should encode special characters in agent name', async () => {
    mockMutateOk();

    await resetAllSpecificity('agent/name');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/v1/routing/agent%2Fname/specificity/reset-all',
      { credentials: 'include', method: 'POST' },
    );
  });
});
