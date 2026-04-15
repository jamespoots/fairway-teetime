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

type RequestTraceEntry = {
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  tokenLikeRequestHeaders: Record<string, string>;
  postData: string;
  responseStatus: number | null;
  responseHeaders: Record<string, string>;
  responseBody: string;
};

type HiddenFieldSummary = {
  tagName: string;
  type: string;
  name: string;
  id: string;
  className: string;
  value: string;
};

type MetaTagSummary = {
  name: string;
  id: string;
  className: string;
  content: string;
};

type ScriptTokenSummary = {
  src: string;
  snippet: string;
};

type SearchResultFormElementSummary = {
  tagName: string;
  type: string;
  name: string;
  id: string;
  className: string;
  value: string;
  text: string;
};

type HiddenFieldDiagnostics = {
  hiddenInputs: HiddenFieldSummary[];
  metaTags: MetaTagSummary[];
  tokenLikeFields: HiddenFieldSummary[];
  tokenLikeMetaTags: MetaTagSummary[];
  tokenLikeScriptTags: ScriptTokenSummary[];
  searchResultFormElements: SearchResultFormElementSummary[];
  cookieTokenNames: string[];
  localStorageTokenKeys: string[];
  sessionStorageTokenKeys: string[];
};

type AuthSummary = {
  hiddenTokenFieldsFound: HiddenFieldSummary[];
  tokenLikeHeadersPerRequest: Array<{
    url: string;
    method: string;
    tokenLikeRequestHeaders: Record<string, string>;
  }>;
  documentCookieContainsTokenLikeNames: boolean;
  documentCookieTokenNames: string[];
  localStorageContainsTokenLikeKeys: boolean;
  localStorageTokenKeys: string[];
  sessionStorageContainsTokenLikeKeys: boolean;
  sessionStorageTokenKeys: string[];
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

function isTracedApiUrl(url: string): boolean {
  return [
    '/api/search/search',
    '/api/search/init',
    '/api/login/login',
    '/api/search/gsahs',
  ].some((path) => url.includes(path));
}

function isTokenLikeKey(value: string): boolean {
  return /(csrf|token|auth|verification|x-requested-with|requested-with)/i.test(
    value,
  );
}

function extractTokenLikeHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key, value]) => {
      if (key.startsWith(':')) {
        return false;
      }

      return isTokenLikeKey(key) || isTokenLikeKey(value);
    }),
  );
}

function redactHeaders(
  headers: Record<string, string>,
  redactedKeys: string[],
): Record<string, string> {
  const redactedKeySet = new Set(redactedKeys.map((key) => key.toLowerCase()));

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      redactedKeySet.has(key.toLowerCase()) ? '[REDACTED]' : value,
    ]),
  );
}

async function writeRequestTraceFile(
  traces: RequestTraceEntry[],
): Promise<void> {
  await writeFile(
    'debug-ezlinks-request-trace.json',
    JSON.stringify(traces, null, 2),
    'utf8',
  );
}

async function writeHiddenFieldsFile(
  diagnostics: HiddenFieldDiagnostics,
): Promise<void> {
  await writeFile(
    'debug-ezlinks-hidden-fields.json',
    JSON.stringify(diagnostics, null, 2),
    'utf8',
  );
}

async function writeAuthSummaryFile(summary: AuthSummary): Promise<void> {
  await writeFile(
    'debug-ezlinks-auth-summary.json',
    JSON.stringify(summary, null, 2),
    'utf8',
  );
}

async function collectHiddenFieldDiagnostics(
  page: Page,
): Promise<HiddenFieldDiagnostics> {
  return page.evaluate(() => {
    const normalizeText = (value: string | null | undefined): string =>
      (value || '').replace(/\s+/g, ' ').trim();

    const isTokenLike = (value: string): boolean =>
      /(csrf|token|auth|verification|request)/i.test(value);

    const toHiddenFieldSummary = (element: Element): HiddenFieldSummary => {
      const htmlElement = element as HTMLInputElement;

      return {
        tagName: element.tagName.toLowerCase(),
        type: htmlElement.type || '',
        name: element.getAttribute('name') || '',
        id: element.getAttribute('id') || '',
        className: element.getAttribute('class') || '',
        value: htmlElement.value || element.getAttribute('value') || '',
      };
    };

    const toMetaTagSummary = (element: Element): MetaTagSummary => ({
      name: element.getAttribute('name') || element.getAttribute('property') || '',
      id: element.getAttribute('id') || '',
      className: element.getAttribute('class') || '',
      content: element.getAttribute('content') || '',
    });

    const hiddenInputs = Array.from(
      document.querySelectorAll('input[type="hidden"]'),
    ).map((element) => toHiddenFieldSummary(element));

    const metaTags = Array.from(document.querySelectorAll('meta')).map((element) =>
      toMetaTagSummary(element),
    );

    const tokenLikeFields = Array.from(document.querySelectorAll('input, textarea, select'))
      .filter((element) => {
        const joined = [
          element.getAttribute('name') || '',
          element.getAttribute('id') || '',
          element.getAttribute('class') || '',
        ].join(' ');

        return isTokenLike(joined);
      })
      .map((element) => toHiddenFieldSummary(element));

    const tokenLikeMetaTags = metaTags.filter((metaTag) =>
      isTokenLike(`${metaTag.name} ${metaTag.id} ${metaTag.className} ${metaTag.content}`),
    );

    const tokenLikeScriptTags = Array.from(document.querySelectorAll('script'))
      .map((element) => ({
        src: element.getAttribute('src') || '',
        text: normalizeText(element.textContent),
      }))
      .filter((scriptTag) => isTokenLike(scriptTag.text))
      .map((scriptTag) => ({
        src: scriptTag.src,
        snippet: scriptTag.text.slice(0, 500),
      }));

    const searchRoot = document.querySelector('.search-result') || document.body;
    const searchResultFormElements = Array.from(
      searchRoot.querySelectorAll('form, input, select, textarea, button'),
    ).map((element) => {
      const htmlElement = element as
        | HTMLInputElement
        | HTMLSelectElement
        | HTMLTextAreaElement
        | HTMLButtonElement;

      return {
        tagName: element.tagName.toLowerCase(),
        type: 'type' in htmlElement ? htmlElement.type || '' : '',
        name: element.getAttribute('name') || '',
        id: element.getAttribute('id') || '',
        className: element.getAttribute('class') || '',
        value: 'value' in htmlElement ? htmlElement.value || '' : '',
        text: normalizeText(htmlElement.textContent).slice(0, 300),
      };
    });

    const cookieTokenNames = document.cookie
      .split(';')
      .map((part) => part.trim().split('=')[0] || '')
      .filter((name) => isTokenLike(name));

    const localStorageTokenKeys = Array.from({ length: window.localStorage.length }, (_, index) =>
      window.localStorage.key(index) || '',
    ).filter((key) => isTokenLike(key));

    const sessionStorageTokenKeys = Array.from({ length: window.sessionStorage.length }, (_, index) =>
      window.sessionStorage.key(index) || '',
    ).filter((key) => isTokenLike(key));

    return {
      hiddenInputs,
      metaTags,
      tokenLikeFields,
      tokenLikeMetaTags,
      tokenLikeScriptTags,
      searchResultFormElements,
      cookieTokenNames,
      localStorageTokenKeys,
      sessionStorageTokenKeys,
    };
  });
}

function buildAuthSummary(
  hiddenFieldDiagnostics: HiddenFieldDiagnostics,
  requestTraces: RequestTraceEntry[],
): AuthSummary {
  return {
    hiddenTokenFieldsFound: hiddenFieldDiagnostics.tokenLikeFields,
    tokenLikeHeadersPerRequest: requestTraces
      .filter((trace) => isTracedApiUrl(trace.url))
      .map((trace) => ({
        url: trace.url,
        method: trace.method,
        tokenLikeRequestHeaders: trace.tokenLikeRequestHeaders,
      })),
    documentCookieContainsTokenLikeNames:
      hiddenFieldDiagnostics.cookieTokenNames.length > 0,
    documentCookieTokenNames: hiddenFieldDiagnostics.cookieTokenNames,
    localStorageContainsTokenLikeKeys:
      hiddenFieldDiagnostics.localStorageTokenKeys.length > 0,
    localStorageTokenKeys: hiddenFieldDiagnostics.localStorageTokenKeys,
    sessionStorageContainsTokenLikeKeys:
      hiddenFieldDiagnostics.sessionStorageTokenKeys.length > 0,
    sessionStorageTokenKeys: hiddenFieldDiagnostics.sessionStorageTokenKeys,
  };
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
  let context;

  try {
    console.log('EZLinks launch using channel=chrome');
    context = await chromium.launchPersistentContext(
      '.playwright/ezlinks-profile',
      {
        channel: 'chrome',
        headless: false,
        slowMo: 50,
        viewport: { width: 1280, height: 800 },
      },
    );
  } catch (error: unknown) {
    console.warn('EZLinks chrome channel launch failed, falling back:', error);
    context = await chromium.launchPersistentContext(
      '.playwright/ezlinks-profile',
      {
        headless: false,
        slowMo: 50,
        viewport: { width: 1280, height: 800 },
      },
    );
  }

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const failedRequests: FailedRequestSummary[] = [];
    const responseSummaries: NetworkResponseSummary[] = [];
    const requestTraces: RequestTraceEntry[] = [];
    let hiddenFieldDiagnostics: HiddenFieldDiagnostics = {
      hiddenInputs: [],
      metaTags: [],
      tokenLikeFields: [],
      tokenLikeMetaTags: [],
      tokenLikeScriptTags: [],
      searchResultFormElements: [],
      cookieTokenNames: [],
      localStorageTokenKeys: [],
      sessionStorageTokenKeys: [],
    };
    let searchRequestReturned403 = false;

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

    page.on('request', async (request) => {
      const requestUrl = request.url();

      if (!isTracedApiUrl(requestUrl)) {
        return;
      }

      const traceEntry: RequestTraceEntry = {
        url: requestUrl,
        method: request.method(),
        requestHeaders: {},
        tokenLikeRequestHeaders: {},
        postData: request.postData() || '',
        responseStatus: null,
        responseHeaders: {},
        responseBody: '',
      };

      try {
        traceEntry.requestHeaders = redactHeaders(
          await request.allHeaders(),
          ['cookie', 'authorization'],
        );
      } catch (error: unknown) {
        traceEntry.requestHeaders = {
          error: `Failed to read request headers: ${String(error)}`,
        };
      }

      traceEntry.tokenLikeRequestHeaders = extractTokenLikeHeaders(
        traceEntry.requestHeaders,
      );

      requestTraces.push(traceEntry);

      console.log('EZLinks traced request method:', traceEntry.method, traceEntry.url);
      console.log('EZLinks traced request headers:', traceEntry.requestHeaders);
      console.log(
        'EZLinks traced token-like request headers:',
        traceEntry.tokenLikeRequestHeaders,
      );
      if (traceEntry.postData) {
        console.log('EZLinks traced request postData:', traceEntry.postData);
      }
    });

    page.on('response', async (response) => {
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

      if (!isTracedApiUrl(responseUrl)) {
        return;
      }

      const traceEntry =
        [...requestTraces]
          .reverse()
          .find(
            (entry) =>
              entry.url === responseUrl &&
              entry.method === request.method() &&
              entry.responseStatus === null,
          ) || null;

      if (!traceEntry) {
        return;
      }

      traceEntry.responseStatus = response.status();
      if (
        responseUrl.includes('/api/search/search') &&
        response.status() === 403
      ) {
        searchRequestReturned403 = true;
      }

      try {
        traceEntry.responseHeaders = redactHeaders(
          await response.allHeaders(),
          ['set-cookie'],
        );
      } catch (error: unknown) {
        traceEntry.responseHeaders = {
          error: `Failed to read response headers: ${String(error)}`,
        };
      }

      try {
        traceEntry.responseBody = (await response.text()).slice(0, 2000);
      } catch (error: unknown) {
        traceEntry.responseBody = `Failed to read response body: ${String(error)}`;
      }

      console.log('EZLinks traced response status:', traceEntry.responseStatus, responseUrl);
      console.log('EZLinks traced response headers:', traceEntry.responseHeaders);
      console.log('EZLinks traced response body:', traceEntry.responseBody);
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

    hiddenFieldDiagnostics = await collectHiddenFieldDiagnostics(page);
    await writeHiddenFieldsFile(hiddenFieldDiagnostics);
    await writeAuthSummaryFile(
      buildAuthSummary(hiddenFieldDiagnostics, requestTraces),
    );

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

      await writeRequestTraceFile(requestTraces);
      await writeAuthSummaryFile(
        buildAuthSummary(hiddenFieldDiagnostics, requestTraces),
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

    await writeRequestTraceFile(requestTraces);
    await writeAuthSummaryFile(
      buildAuthSummary(hiddenFieldDiagnostics, requestTraces),
    );

    if (searchRequestReturned403) {
      return [];
    }

    return [];
  } finally {
    await context.close();
  }
}