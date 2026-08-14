export function evaluateWatchdog({ ready = false, ws = {}, owner = false, unknownCount = 0, riskHalt = false, exitBacklog = 0, watermarkStalled = false } = {}) {
  const reasons = [];
  if (!ready) reasons.push('READY_FALSE');
  for (const channel of ['public', 'private', 'business']) if (!ws[channel]) reasons.push(`WS_${channel.toUpperCase()}_STALE`);
  if (!owner) reasons.push('OWNER_LOST');
  if (unknownCount) reasons.push('UNKNOWN_ORDER');
  if (riskHalt) reasons.push('BUY_RISK_HALT');
  if (exitBacklog) reasons.push('EXIT_BACKLOG');
  if (watermarkStalled) reasons.push('WATERMARK_STALLED');
  return { healthy: reasons.length === 0, reasons };
}
