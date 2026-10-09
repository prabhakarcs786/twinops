import { startIncident, type RunResult } from '../engine/orchestrator.ts';

export const DEMO_SEED = 5;
let cached: RunResult | null = null;

/** One real seeded F1 run shared by every landing illustration, so their numbers agree. */
export function demoRun(): RunResult {
  cached ??= startIncident({ pack: 'core', fault: 'route_misconfig', seed: DEMO_SEED }).run;
  return cached;
}

export const letterOf = (label?: string) => label?.split(' · ')[0] ?? '';
export const nameOf = (label?: string) => label?.split(' · ').slice(1).join(' · ') ?? '';
