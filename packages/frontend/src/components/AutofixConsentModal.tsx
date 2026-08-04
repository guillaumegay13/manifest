import { Show, type Component } from 'solid-js';
import { Portal } from 'solid-js/web';

/**
 * The self-hosted Auto-fix disclosure. Enabling Auto-fix is what sends failing
 * requests off the box, so the same wording has to appear wherever that switch
 * can be flipped — the per-agent toggle and the workspace default. Keeping one
 * component means the consent text and the links can never drift apart.
 */
const AutofixConsentModal: Component<{
  open: boolean;
  /** Scope wording: what the confirmation will actually turn on. */
  scope?: string;
  onCancel: () => void;
  onConfirm: () => void;
}> = (props) => (
  <Portal>
    <Show when={props.open}>
      <div
        class="modal-overlay"
        onClick={(event) => {
          if (event.target === event.currentTarget) props.onCancel();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') props.onCancel();
        }}
      >
        <div
          class="modal-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="autofix-consent-title"
          aria-describedby="autofix-consent-description"
          style="max-width: 500px;"
        >
          <h2 class="modal-card__title" id="autofix-consent-title">
            Enable hosted Auto-fix?
          </h2>
          <p class="modal-card__desc" id="autofix-consent-description">
            Failed requests {props.scope ?? ''}will be sent to Manifest Auto-fix for diagnosis and
            repair. Provider authorization credentials are not sent.{' '}
            <a
              href="https://manifest.build/docs/autofix/"
              target="_blank"
              rel="noopener noreferrer"
            >
              How Auto-fix works
            </a>
            .
          </p>
          <p class="autofix-consent__legal">
            By enabling Auto-fix, you agree to Manifest&apos;s{' '}
            <a href="https://manifest.build/terms" target="_blank" rel="noopener noreferrer">
              Terms
            </a>{' '}
            and{' '}
            <a href="https://manifest.build/privacy" target="_blank" rel="noopener noreferrer">
              Privacy Policy
            </a>
            .
          </p>
          <div class="modal-card__footer">
            <button type="button" class="btn btn--ghost btn--sm" onClick={() => props.onCancel()}>
              Cancel
            </button>
            <button
              type="button"
              class="btn btn--primary btn--sm"
              onClick={() => props.onConfirm()}
            >
              Agree &amp; enable Auto-fix
            </button>
          </div>
        </div>
      </div>
    </Show>
  </Portal>
);

export default AutofixConsentModal;
