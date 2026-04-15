import { chromium } from 'playwright';

import type { TeeTime } from '../types/teeTime';

export async function getEzLinksTeeTimes(
  url: string,
  date: string,
): Promise<TeeTime[]> {
  const browser = await chromium.launch();

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch (error: unknown) {
      console.warn('EZLinks did not reach network idle within 10s:', error);
    }

    console.log(`EZLinks page title for ${date}:`, await page.title());

    return [];
  } finally {
    await browser.close();
  }
}