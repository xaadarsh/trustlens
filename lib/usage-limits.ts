const USAGE_KEY = 'trustlens_ai_uses';

export const FREE_TRIAL_LIMIT = 5;

export async function getUsageCount(): Promise<number> {
  const stored = await browser.storage.local.get(USAGE_KEY);
  const value = Number(stored[USAGE_KEY] ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export async function getRemainingTrials(): Promise<number> {
  const used = await getUsageCount();
  return Math.max(0, FREE_TRIAL_LIMIT - used);
}

export async function hasTrialsLeft(): Promise<boolean> {
  return (await getRemainingTrials()) > 0;
}

export async function incrementUsage(): Promise<number> {
  const used = await getUsageCount();
  const next = used + 1;
  await browser.storage.local.set({ [USAGE_KEY]: next });
  return next;
}

export async function resetUsageForDev(): Promise<void> {
  await browser.storage.local.set({ [USAGE_KEY]: 0 });
}
