import { getEzLinksTeeTimes } from '../adapters/ezlinks';

async function main(): Promise<void> {
  console.log('Empire Ranch EZLinks test');

  const results = await getEzLinksTeeTimes(
    'https://empireranch.ezlinksgolf.com/',
    '2026-04-15',
  );

  console.log(results);
}

void main().catch((error: unknown) => {
  console.error('Failed to fetch EZLinks tee times:', error);
  process.exitCode = 1;
});