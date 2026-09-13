/** Longest connection label echoed into a log line. */
const MAX_LOGGED_LABEL_LENGTH = 64;

/**
 * Connection labels are user-authored text. Strip control characters (a
 * newline would let a label forge extra log lines) and cap the length before
 * interpolating one into a log message.
 */
export function forLogLabel(label: string): string {
  const cleaned = [...label]
    .map((c) => {
      const code = c.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? ' ' : c;
    })
    .join('');
  return cleaned.length > MAX_LOGGED_LABEL_LENGTH
    ? `${cleaned.slice(0, MAX_LOGGED_LABEL_LENGTH)}…`
    : cleaned;
}
