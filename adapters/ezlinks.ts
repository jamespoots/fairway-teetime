import { writeFile } from 'node:fs/promises';
import readline from 'node:readline';

import { chromium } from 'playwright';
import type { Page } from 'playwright';

import type { TeeTime } from '../types/teeTime';

type VisibleElementSummary = {
  text: string;
  ariaLabel: string;
};

type VisibleLinkSummary = {
  text: string;
  href: string;
};

type VisibleInputSummary = {
  type: string;
  name: string;
  placeholder: string;
  ariaLabel: string;
  value: string;
};

type CandidateElementSummary = {
  tagName: string;
  className: string;
  text: string;
};

type EzLinksDebugDump = {
  title: string;
  url: string;
  bodyText: string;
  buttons: VisibleElementSummary[];
  links: VisibleLinkSummary[];
  inputs: VisibleInputSummary[];
  candidateElements: CandidateElementSummary[];
};

type EzLinksAfterDateChangeDump = {
  title: string;
  url: string;
  bodyText: string;
  searchResultText: string;
  searchResultDataText: string;
  pickerDateValue: string;
  matchedTimes: string[];
};

type FailedRequestSummary = {
  url: string;
  errorText: string;
};

type NetworkResponseSummary = {
  url: string;
  status: number;
};

type SpinnerDebugDump = {
  title: string;
  url: string;
  bodyText: string;
  failedRequests: FailedRequestSummary[];
  responseSummaries: NetworkResponseSummary[];
};

function waitForEnter(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(
      'Complete the human verification in the browser, then press Enter here to continue.',
      () => {
        rl.close();
        resolve();
      },
    );
  });
}

function normalizeDate(input: string): string {
  const trimmed = input.trim();
  const parsedDate = new Date(`${trimmed}T00:00:00`);

  if (!Number.isNaN(parsedDate.getTime())) {
    const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
    const day = String(parsedDate.getDate()).padStart(2, '0');
    const year = String(parsedDate.getFullYear());

    return `${month}/${day}/${year}`;
  }

  const match = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) {
    return trimmed;
  }

  const [, month, day, year] = match;
  return `${month.padStart(2, '0')}/${day.padStart(2, '0')}/${year}`;
}

function isInterestingNetworkUrl(url: string): boolean {
  return /search|tee|time|rate|slot|inventory|course|ezlinks/i.test(url);
}

async function isSpinnerVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const isVisible = (element: Element): boolean => {
      const htmlElement = element as HTMLElement;
      const style = window.getComputedStyle(htmlElement);
      const rect = htmlElement.getBoundingClientRect();

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    return Array.from(document.querySelectorAll('*')).some((element) => {
      if (!isVisible(element)) {
        return false;
      }

      const htmlElement = element as HTMLElement;
      const className = String(htmlElement.className || '');
      const text = htmlElement.innerText || htmlElement.textContent || '';

      return /spinner|loading/i.test(className) || /loading/i.test(text);
    });
  });
}

async function inspectSpinner(page: Page): Promise<{
  spinnerOuterHtml: string;
  parentOuterHtml: string;
}> {
  return page.evaluate(() => {
    const isVisible = (element: Element): boolean => {
      const htmlElement = element as HTMLElement;
      const style = window.getComputedStyle(htmlElement);
      const rect = htmlElement.getBoundingClientRect();

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const spinnerElement = Array.from(document.querySelectorAll('*')).find(
      (element) => {
        if (!isVisible(element)) {
          return false;
        }

        const htmlElement = element as HTMLElement;
        const className = String(htmlElement.className || '');
        const text = htmlElement.innerText || htmlElement.textContent || '';

        return /spinner|loading/i.test(className) || /loading/i.test(text);
      },
    ) as HTMLElement | undefined;

    const parentElement = spinnerElement?.parentElement;

    return {
      spinnerOuterHtml: spinnerElement?.outerHTML || '',
      parentOuterHtml: (parentElement?.outerHTML || '').slice(0, 2000),
    };
  });
}

async function collectSpinnerDebugDump(
  page: Page,
  failedRequests: FailedRequestSummary[],
  responseSummaries: NetworkResponseSummary[],
): Promise<SpinnerDebugDump> {
  return page.evaluate(
    ({ recentFailedRequests, recentResponses }) => {
      const normalizeText = (value: string | null | undefined): string =>
        (value || '').replace(/\s+/g, ' ').trim();

      return {
        title: document.title,
        url: window.location.href,
        bodyText: normalizeText(document.body?.innerText).slice(0, 5000),
        failedRequests: recentFailedRequests,
        responseSummaries: recentResponses,
      };
    },
    {
      recentFailedRequests: failedRequests,
      recentResponses: responseSummaries,
    },
  );
}

async function waitForLoadingToClear(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const isVisible = (element: Element): boolean => {
          const htmlElement = element as HTMLElement;
          const style = window.getComputedStyle(htmlElement);
          const rect = htmlElement.getBoundingClientRect();

          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            rect.width > 0 &&
            rect.height > 0
          );
        };

        const loadingIndicators = Array.from(document.querySelectorAll('*')).filter(
          (element) => {
            if (!isVisible(element)) {
              return false;
            }

            const htmlElement = element as HTMLElement;
            const className = htmlElement.className || '';
            const text = htmlElement.innerText || htmlElement.textContent || '';

            return (
              /spinner|loading/i.test(String(className)) ||
              /loading/i.test(text)
            );
          },
        );

        return loadingIndicators.length === 0;
      },
      { timeout: 10000 },
    );
  } catch (error: unknown) {
    console.warn('EZLinks loading indicators did not clear within 10s:', error);
  }
}

async function collectDebugDump(page: Page): Promise<EzLinksDebugDump> {
  return page.evaluate(() => {
    const isVisible = (element: Element): boolean => {
      const htmlElement = element as HTMLElement;
      const style = window.getComputedStyle(htmlElement);
      const rect = htmlElement.getBoundingClientRect();

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const normalizeText = (value: string | null | undefined): string =>
      (value || '').replace(/\s+/g, ' ').trim();

    const visibleButtons = Array.from(document.querySelectorAll('button'))
      .filter((element) => isVisible(element))
      .map((element) => ({
        text: normalizeText(element.textContent),
        ariaLabel: normalizeText(element.getAttribute('aria-label')),
      }));

    const visibleLinks = Array.from(document.querySelectorAll('a'))
      .filter((element) => isVisible(element))
      .map((element) => ({
        text: normalizeText(element.textContent),
        href: element.getAttribute('href') || '',
      }));

    const visibleInputs = Array.from(
      document.querySelectorAll('input, textarea, select'),
    )
      .filter((element) => isVisible(element))
      .map((element) => {
        const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

        return {
          type: 'type' in input ? input.type || '' : '',
          name: input.getAttribute('name') || '',
          placeholder: input.getAttribute('placeholder') || '',
          ariaLabel: input.getAttribute('aria-label') || '',
          value: 'value' in input ? input.value || '' : '',
        };
      });

    const candidateElements = Array.from(document.querySelectorAll('*'))
      .filter((element) => {
        if (!isVisible(element)) {
          return false;
        }

        const className = String((element as HTMLElement).className || '');
        return /time|tee|slot|rate|price|result|search|date/i.test(className);
      })
      .map((element) => ({
        tagName: element.tagName.toLowerCase(),
        className: String((element as HTMLElement).className || ''),
        text: normalizeText((element as HTMLElement).innerText || element.textContent),
      }));

    return {
      title: document.title,
      url: window.location.href,
      bodyText: normalizeText(document.body?.innerText).slice(0, 5000),
      buttons: visibleButtons,
      links: visibleLinks,
      inputs: visibleInputs,
      candidateElements,
    };
  });
}

async function collectAfterDateChangeDump(
  page: Page,
): Promise<EzLinksAfterDateChangeDump> {
  return page.evaluate(() => {
    const normalizeText = (value: string | null | undefined): string =>
      (value || '').replace(/\s+/g, ' ').trim();

    const isVisible = (element: Element): boolean => {
      const htmlElement = element as HTMLElement;
      const style = window.getComputedStyle(htmlElement);
      const rect = htmlElement.getBoundingClientRect();

      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const timePattern = /\b(?:1[0-2]|0?[1-9]):[0-5]\d\s?(?:AM|PM)\b/g;
    const matchedTimes = Array.from(document.querySelectorAll('*'))
      .filter((element) => isVisible(element))
      .flatMap((element) => {
        const text = normalizeText(
          (element as HTMLElement).innerText || element.textContent,
        );
        return text.match(timePattern) || [];
      });

    return {
      title: document.title,
      url: window.location.href,
      bodyText: normalizeText(document.body?.innerText).slice(0, 5000),
      searchResultText: normalizeText(
        document.querySelector('.search-result')?.textContent,
      ),
      searchResultDataText: normalizeText(
        document.querySelector('.search-result-data')?.textContent,
      ),
      pickerDateValue: (
        (document.querySelector('input[name="pickerDate"]') as HTMLInputElement | null)
          ?.value || ''
      ).trim(),
      matchedTimes: Array.from(new Set(matchedTimes)),
    };
  });
}

export async function getEzLinksTeeTimes(
  url: string,
  date: string,
): Promise<TeeTime[]> {
  const normalizedDate = normalizeDate(date);
  const context = await chromium.launchPersistentContext(
    '.playwright/ezlinks-profile',
    {
    headless: false,
    slowMo: 50,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    },
  );

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const failedRequests: FailedRequestSummary[] = [];
    const responseSummaries: NetworkResponseSummary[] = [];

    page.on('console', (message) => {
      console.log(`[EZLinks console:${message.type()}]`, message.text());
    });

    page.on('pageerror', (error) => {
      console.error('[EZLinks pageerror]', error);
    });

    page.on('requestfailed', (request) => {
      const failedRequest = {
        url: request.url(),
        errorText: request.failure()?.errorText || 'unknown error',
      };

      failedRequests.push(failedRequest);
      if (failedRequests.length > 30) {
        failedRequests.shift();
      }

      console.warn(
        'EZLinks failed request:',
        failedRequest.url,
        failedRequest.errorText,
      );
    });

    page.on('response', (response) => {
      const request = response.request();
      const resourceType = request.resourceType();
      const responseUrl = response.url();

      if (
        (resourceType === 'xhr' || resourceType === 'fetch') &&
        isInterestingNetworkUrl(responseUrl)
      ) {
        const responseSummary = {
          url: responseUrl,
          status: response.status(),
        };

        responseSummaries.push(responseSummary);
        if (responseSummaries.length > 50) {
          responseSummaries.shift();
        }

        console.log(
          'EZLinks XHR/fetch response:',
          responseSummary.status,
          responseSummary.url,
        );
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded' });

    await page.screenshot({ path: 'debug-ezlinks.png', fullPage: true });

    const initialTitle = await page.title();
    const initialUrl = page.url();
    const bodyText = await page.locator('body').innerText().catch(() => '');

    console.log(`EZLinks page title for ${date}:`, initialTitle);
    console.log('EZLinks current URL:', initialUrl);

    if (
      initialTitle.includes('Just a moment') ||
      bodyText.includes('Verify you are human')
    ) {
      await waitForEnter();
      await page.waitForTimeout(3000);
      await page.screenshot({
        path: 'debug-ezlinks-after-verify.png',
        fullPage: true,
      });

      console.log('EZLinks updated page title:', await page.title());
      console.log('EZLinks updated URL:', page.url());
    }

    await page.waitForTimeout(8000);

    if (await isSpinnerVisible(page)) {
      console.warn('EZLinks spinner still visible after 8 seconds.');
      await page.screenshot({ path: 'debug-ezlinks-spinner.png', fullPage: true });
      await writeFile('debug-ezlinks-spinner.html', await page.content(), 'utf8');

      const spinnerInspection = await inspectSpinner(page);
      console.log('EZLinks spinner outerHTML:', spinnerInspection.spinnerOuterHtml);
      console.log(
        'EZLinks spinner parent outerHTML:',
        spinnerInspection.parentOuterHtml,
      );

      const spinnerDebugDump = await collectSpinnerDebugDump(
        page,
        failedRequests,
        responseSummaries,
      );
      await writeFile(
        'debug-ezlinks-network.json',
        JSON.stringify(spinnerDebugDump, null, 2),
        'utf8',
      );

      return [];
    }

    await waitForLoadingToClear(page);

    const debugDump = await collectDebugDump(page);
    await writeFile(
      'debug-ezlinks-selectors.json',
      JSON.stringify(debugDump, null, 2),
      'utf8',
    );

    console.log('EZLinks buttons found:', debugDump.buttons.length);
    console.log('EZLinks inputs found:', debugDump.inputs.length);
    console.log(
      'EZLinks candidate tee-time/result elements found:',
      debugDump.candidateElements.length,
    );

    const dateInput = page.locator('input[name="pickerDate"]').first();
    const hasDateInput = (await dateInput.count()) > 0;
    const previousSearchResultDataText = await page
      .locator('.search-result-data')
      .first()
      .innerText()
      .catch(() => '');

    let previousDateValue = '';
    let updatedDateValue = '';
    let searchResultDataChanged = false;
    let afterDateChangeDump: EzLinksAfterDateChangeDump | null = null;

    if (hasDateInput) {
      previousDateValue = await dateInput.inputValue().catch(() => '');

      try {
        await dateInput.focus();
        await dateInput.fill('');
        await dateInput.fill(normalizedDate);
        await dateInput.press('Enter').catch(() => undefined);
        await dateInput.blur().catch(() => undefined);
        await dateInput.evaluate((element) => {
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        });
      } catch (error: unknown) {
        console.warn('EZLinks date input update failed:', error);
      }

      updatedDateValue = await dateInput.inputValue().catch(() => '');

      try {
        await page.waitForFunction(
          (previousValue) => {
            const element = document.querySelector('.search-result-data');
            const currentValue = (element?.textContent || '')
              .replace(/\s+/g, ' ')
              .trim();
            return currentValue.length > 0 && currentValue !== previousValue;
          },
          previousSearchResultDataText.replace(/\s+/g, ' ').trim(),
          { timeout: 10000 },
        );
        searchResultDataChanged = true;
      } catch (error: unknown) {
        console.warn(
          'EZLinks search-result-data did not change within 10s:',
          error,
        );
      }

      await waitForLoadingToClear(page);
      await page.screenshot({
        path: 'debug-ezlinks-after-date-change.png',
        fullPage: true,
      });
      afterDateChangeDump = await collectAfterDateChangeDump(page);
      await writeFile(
        'debug-ezlinks-after-date-change.json',
        JSON.stringify(afterDateChangeDump, null, 2),
        'utf8',
      );
    } else {
      console.warn('EZLinks pickerDate input was not found.');
    }

    console.log('EZLinks previous date value:', previousDateValue);
    console.log('EZLinks updated date value:', updatedDateValue);
    console.log('EZLinks search-result-data changed:', searchResultDataChanged);
    console.log(
      'EZLinks matched time-like strings:',
      afterDateChangeDump?.matchedTimes ?? [],
    );

    return [];
  } finally {
    await context.close();
  }
}