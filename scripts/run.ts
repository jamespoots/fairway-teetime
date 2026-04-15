import { getEzLinksTeeTimes } from '../adapters/ezlinks';

async function main(): Promise<void> {
  const results = await getEzLinksTeeTimes(
    'https://tealbend.ezlinksgolf.com/',
    new Date().toISOString().slice(0, 10),
  );

  console.log(results);
}

void main().catch((error: unknown) => {
  console.error('Failed to fetch EZLinks tee times:', error);
  process.exitCode = 1;
});