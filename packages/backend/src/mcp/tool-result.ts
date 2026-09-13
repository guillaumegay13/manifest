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
