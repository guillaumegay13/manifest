/**
 * MCP tool results are content blocks. Manifest's tools return JSON payloads, so
 * every handler funnels through these two wrappers — one shape for the model to
 * parse, and errors flagged with `isError` so the client renders them as
 * failures rather than data.
 */
export function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

export function err(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
  };
}

/**
 * Await a tool's payload and wrap it. A thrown Error becomes an `isError`
 * result with the message, so one bad call cannot tear down the session.
 */
export function result(promise: Promise<unknown>) {
  return promise.then(ok).catch((e: unknown) => err(e instanceof Error ? e.message : String(e)));
}
