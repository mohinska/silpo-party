/** Decode MCP content without assuming the remote payload's domain shape. */
export function readToolData(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  if (record.structuredContent) return record.structuredContent;
  if (!Array.isArray(record.content)) return result;
  const values = record.content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const text = (block as Record<string, unknown>).text;
    if (typeof text !== "string") return [];
    try {
      return [JSON.parse(text) as unknown];
    } catch {
      return [text];
    }
  });
  return values.length === 1 ? values[0] : values;
}
