export function agentUsageDailyReadsEnabled(tenantId: string | null): boolean {
  if (!tenantId) return false;
  if (process.env['AGENT_USAGE_DAILY_READS'] === 'true') return true;
  const selected = process.env['AGENT_USAGE_DAILY_READ_TENANTS'];
  if (!selected) return false;
  return selected
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(tenantId);
}
