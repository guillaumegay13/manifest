import type {
  PhoenixExplanation,
  PhoenixHealStatus,
  PhoenixOperation,
  PhoenixProviderError,
} from './phoenix.types';
import type { RecordableManifestCode } from '../../common/errors/manifest-error';

/**
 * How an Auto-fix attempt ended:
 * - `healed`     — a patched request eventually succeeded.
 * - `unfixable`  — Phoenix had no patch (`no_patch`) or returned an empty one.
 * - `resolving`  — Phoenix is still authoring a patch (novel error); nothing to
 *                  resend this time. A later request for the same issue may heal.
 * - `exhausted`  — the healing service was unreachable or the attempt threw
 *                  before completing.
 */
export type AutofixOutcome = 'healed' | 'unfixable' | 'resolving' | 'exhausted';

/**
 * One request actually sent to the provider during healing, in order. Entry 0
 * (`origin: 'original'`) is the agent's own request; later `autofix` entries are
 * the bodies Phoenix produced. The heal decision fields (`issue_id` … ) describe
 * what Phoenix said about THIS entry's failure; `patch_worked` says whether the
 * patch derived here produced a working request.
 */
export interface AutofixChainEntry {
  attempt: number;
  origin: 'original' | 'autofix';
  request: Record<string, unknown>;
  http_status: number;
  /** Absent on the terminal success entry. */
  error?: PhoenixProviderError;
  phoenix_status?: PhoenixHealStatus;
  issue_id?: string;
  patch_id?: string | null;
  heal_attempt_id?: string | null;
  operations?: PhoenixOperation[] | null;
  /** Phoenix's human-readable "why" for the fix derived here (null when none). */
  explanation?: PhoenixExplanation | null;
  patch_worked?: boolean;
}

/**
 * The full Auto-fix story. A healed request is recorded as two linked
 * `agent_messages` rows (failed original + successful retry) sharing `groupId`;
 * `chain` carries the per-attempt detail the recorder splits into those rows.
 */
export interface AutofixRecord {
  /** Shared id linking the failed-original and successful-retry rows. */
  groupId: string;
  outcome: AutofixOutcome;
  original_http_status: number;
  chain: AutofixChainEntry[];
  /**
   * Present when the healed failure was Manifest-blocked rather than a provider
   * response (e.g. an M302 unknown model — no provider was ever contacted). The
   * recorder then writes the original row through the Manifest-blocked path
   * (provider/tier NULL, `error_code` stamped) instead of a provider-attributed
   * `auto_fixed` row.
   */
  manifestOrigin?: {
    code: RecordableManifestCode;
    /** The rendered `[🦚 Manifest M###] …` text the caller would have seen. */
    message: string;
    /** The model the caller requested (kept as the row's `model` column). */
    model: string;
  };
}
