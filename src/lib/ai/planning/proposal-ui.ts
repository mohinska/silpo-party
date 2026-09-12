export function groupProposalWarnings(items: Array<{ requirementKey: string; reason: string }>) {
  const grouped = new Map<string, { requirementKey: string; reason: string; count: number }>();
  for (const item of items) {
    const current = grouped.get(item.reason);
    if (current) current.count += 1;
    else grouped.set(item.reason, { ...item, count: 1 });
  }
  return [...grouped.values()];
}
