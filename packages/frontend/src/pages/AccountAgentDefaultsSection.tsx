import { createResource, createSignal, type Component } from 'solid-js';
import {
  getWorkspaceDefaults,
  updateWorkspaceDefaults,
  type WorkspaceDefaults,
} from '../services/api/workspace-defaults.js';
import { checkIsSelfHosted } from '../services/setup-status.js';
import AutofixConsentModal from '../components/AutofixConsentModal.jsx';

/**
 * Workspace-wide defaults for per-agent settings, in Account Preferences.
 *
 * These only decide what an agent does when it has made no choice of its own —
 * flipping one here never overrides an agent whose toggle was set explicitly.
 * In practice that means Auto-fix (whose flag is unset on most agents) moves
 * with this, while recording, which every existing agent has an explicit value
 * for, applies to agents created from here on.
 */
const AccountAgentDefaultsSection: Component = () => {
  const [defaults, { mutate }] = createResource<WorkspaceDefaults>(getWorkspaceDefaults);
  const [selfHosted] = createResource(checkIsSelfHosted);
  const [saving, setSaving] = createSignal<keyof WorkspaceDefaults | null>(null);
  const [confirmingAutofix, setConfirmingAutofix] = createSignal(false);

  const loaded = () => !defaults.loading && !defaults.error;
  const busy = () => saving() !== null || defaults.loading || Boolean(defaults.error);

  // A null workspace value means "no choice stored", so the switch shows what
  // agents actually get today: the deployment default for Auto-fix, on for
  // recording. Flipping it writes an explicit boolean.
  const autofixOn = () => (loaded() ? (defaults()?.autofix ?? !selfHosted()) : false);
  const recordingOn = () => (loaded() ? (defaults()?.recording ?? true) : false);

  const save = async (patch: Partial<WorkspaceDefaults>) => {
    const key = Object.keys(patch)[0] as keyof WorkspaceDefaults;
    setSaving(key);
    try {
      mutate(await updateWorkspaceDefaults(patch));
    } catch {
      // fetchMutate already surfaces the backend error as a toast.
    } finally {
      setSaving(null);
    }
  };

  const toggleAutofix = () => {
    if (busy() || selfHosted.loading) return;
    // Same disclosure gate as the per-agent toggle: on self-hosted, switching
    // Auto-fix on is what consents to failing requests leaving the box.
    if (!autofixOn() && selfHosted()) {
      setConfirmingAutofix(true);
      return;
    }
    void save({ autofix: !autofixOn() });
  };

  return (
    <>
      <h2 class="settings-section__title" id="agent-defaults">
        Agent defaults
      </h2>
      <div class="settings-card">
        <div class="settings-card__body">
          <p class="settings-card__desc">
            What a new agent starts with. Agents you have already configured keep their own setting
            — changing a default here never overrides a choice you made on an agent.
          </p>
        </div>
        <div class="settings-card__row">
          <div class="settings-card__label">
            <span class="settings-card__label-title">Auto-fix failing requests</span>
            <span class="settings-card__label-desc">
              When a request fails with a fixable error, Manifest repairs it and retries once before
              falling back.
            </span>
          </div>
          <div class="settings-card__control settings-card__control--end">
            <button
              type="button"
              role="switch"
              aria-checked={autofixOn()}
              aria-label="Auto-fix by default"
              class="settings-switch"
              classList={{ 'settings-switch--on': autofixOn() }}
              disabled={busy() || selfHosted.loading}
              onClick={toggleAutofix}
            >
              <span class="settings-switch__track">
                <span class="settings-switch__thumb" />
              </span>
            </button>
          </div>
        </div>
        <div class="settings-card__row">
          <div class="settings-card__label">
            <span class="settings-card__label-title">Record requests</span>
            <span class="settings-card__label-desc">
              Store request and response bodies so you can inspect what an agent actually sent.
            </span>
          </div>
          <div class="settings-card__control settings-card__control--end">
            <button
              type="button"
              role="switch"
              aria-checked={recordingOn()}
              aria-label="Record requests by default"
              class="settings-switch"
              classList={{ 'settings-switch--on': recordingOn() }}
              disabled={busy()}
              onClick={() => {
                if (busy()) return;
                void save({ recording: !recordingOn() });
              }}
            >
              <span class="settings-switch__track">
                <span class="settings-switch__thumb" />
              </span>
            </button>
          </div>
        </div>
      </div>
      <AutofixConsentModal
        open={confirmingAutofix()}
        scope="from agents using this default "
        onCancel={() => setConfirmingAutofix(false)}
        onConfirm={() => {
          setConfirmingAutofix(false);
          void save({ autofix: true });
        }}
      />
    </>
  );
};

export default AccountAgentDefaultsSection;
