import { AUTH_TYPES, type AuthType } from './auth-types';

export interface ModelRoute {
  provider: string;
  authType: AuthType;
  model: string;
}

export function routeEquals(
  a: ModelRoute | null | undefined,
  b: ModelRoute | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.provider === b.provider && a.authType === b.authType && a.model === b.model;
}

export function routeKey(route: ModelRoute): string {
  return `${route.provider}|${route.authType}|${route.model}`;
}

export function isModelRoute(value: unknown): value is ModelRoute {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.provider === 'string' &&
    r.provider.length > 0 &&
    typeof r.model === 'string' &&
    r.model.length > 0 &&
    typeof r.authType === 'string' &&
    (AUTH_TYPES as readonly string[]).includes(r.authType)
  );
}
