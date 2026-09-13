import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { parseOAuthTokenBlob } from '../oauth/core';

/**
 * Process-local health state for provider credentials that an upstream rejected
 * with an authentication error (401). A 401 is an auth failure, not a transient
 * one: without this, every request selects the dead connection first, burns an
 * upstream call, and only then falls back — exactly the latency and quota waste
 * reported for dead OpenAI subscription tokens (issue #2883).
 *
 * Entries are keyed by `tenant_providers.id` and carry a fingerprint of the
 * credential value that failed. Re-authenticating replaces the refresh token /
 * API key, so the fingerprint changes and the entry is ignored automatically —
 * this is what lets routing resume without an explicit "clear" on re-auth.
 *
 * In-memory on purpose: routing already resolves selection per request, and a
 * restart simply re-learns the failure on the next attempted call.
 */

/** Longest connection label echoed into a log-safe string (kept in sync with ProviderKeyService). */
const MAX_FINGERPRINT_MATERIAL = 512;
const MAX_TRACKED_CREDENTIALS = 5_000;

export type CredentialAuthFailureReason = 'subscription_token_rejected' | 'api_key_rejected';

export interface CredentialAuthFailure {
  /** Upstream status that rejected the credential (401/403). */
  statusCode: number;
  reason: CredentialAuthFailureReason;
  /** Connection label at the time of failure, for logs and the dashboard. */
  keyLabel?: string;
  /** Provider the credential belongs to, for the dashboard. */
  provider?: string;
  /** Epoch ms of the most recent rejection. */
  at: number;
}

export interface CredentialHealthSnapshot {
  requires_reauth: boolean;
  last_auth_failure: CredentialAuthFailure | null;
}

interface RejectedEntry {
  fingerprint: string;
  failure: CredentialAuthFailure;
}

/**
 * Stable identity for a credential value. For an OAuth blob the refresh token
 * is the stable part (access tokens rotate on every refresh); for an API key the
 * key itself is. Anything else falls back to the raw value.
 */
export function credentialFingerprint(rawValue: string): string {
  const blob = parseOAuthTokenBlob(rawValue);
  const material = blob ? blob.r || blob.t : rawValue;
  return createHash('sha256').update(material.slice(0, MAX_FINGERPRINT_MATERIAL)).digest('hex');
}

@Injectable()
export class CredentialHealthService {
  private readonly rejected = new Map<string, RejectedEntry>();

  /**
   * Record that the credential behind `tenantProviderId` was rejected upstream.
   * Calling again refreshes the failure (new status/label/timestamp) but keeps
   * the same fingerprint unless the credential itself changed.
   */
  markRejected(
    tenantProviderId: string | null | undefined,
    rawValue: string | null | undefined,
    failure: Omit<CredentialAuthFailure, 'at'> & { at?: number },
  ): void {
    if (!tenantProviderId || !rawValue) return;
    if (this.rejected.size >= MAX_TRACKED_CREDENTIALS && !this.rejected.has(tenantProviderId)) {
      const oldest = this.rejected.keys().next().value as string | undefined;
      if (oldest !== undefined) this.rejected.delete(oldest);
    }
    this.rejected.set(tenantProviderId, {
      fingerprint: credentialFingerprint(rawValue),
      failure: { ...failure, at: failure.at ?? Date.now() },
    });
  }

  /**
   * Mark a credential healthy again after a successful upstream call. Only
   * clears the entry when the value still matches the one that failed, so a
   * stale success from a replaced credential cannot erase a fresh failure.
   */
  markHealthy(
    tenantProviderId: string | null | undefined,
    rawValue: string | null | undefined,
  ): void {
    if (!tenantProviderId || !rawValue) return;
    const entry = this.rejected.get(tenantProviderId);
    if (!entry) return;
    if (entry.fingerprint === credentialFingerprint(rawValue)) {
      this.rejected.delete(tenantProviderId);
    }
  }

  /**
   * Whether this exact credential is still the rejected one. A re-authenticated
   * credential (different refresh token / API key) reports healthy and drops the
   * stale entry.
   */
  isRejected(
    tenantProviderId: string | null | undefined,
    rawValue: string | null | undefined,
  ): boolean {
    if (!tenantProviderId || !rawValue) return false;
    const entry = this.rejected.get(tenantProviderId);
    if (!entry) return false;
    if (entry.fingerprint !== credentialFingerprint(rawValue)) {
      this.rejected.delete(tenantProviderId);
      return false;
    }
    return true;
  }

  getFailure(tenantProviderId: string | null | undefined): CredentialAuthFailure | null {
    if (!tenantProviderId) return null;
    return this.rejected.get(tenantProviderId)?.failure ?? null;
  }

  /**
   * Health for the providers API. `credentialUpdatedAtMs` is the connection
   * row's `updated_at`; a row updated after the failure was recorded was
   * re-authenticated (or otherwise edited) and is reported healthy without
   * needing the plaintext credential.
   */
  getSnapshot(
    tenantProviderId: string | null | undefined,
    credentialUpdatedAtMs?: number,
  ): CredentialHealthSnapshot {
    const failure = this.getFailure(tenantProviderId);
    if (!failure) return { requires_reauth: false, last_auth_failure: null };
    if (
      credentialUpdatedAtMs !== undefined &&
      Number.isFinite(credentialUpdatedAtMs) &&
      credentialUpdatedAtMs > failure.at
    ) {
      return { requires_reauth: false, last_auth_failure: null };
    }
    return { requires_reauth: true, last_auth_failure: failure };
  }

  /** Test hook: drop all tracked failures. */
  clear(): void {
    this.rejected.clear();
  }
}
