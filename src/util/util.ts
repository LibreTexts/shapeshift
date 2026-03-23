export async function runBatchedPromises<T>(
  promises: Promise<T>[],
  batchSize: number,
  opt?: { sleepMS: number },
): Promise<T[]> {
  const chunkedPromises = chunk(promises, batchSize);
  const results: T[] = [];
  for (const chunk of chunkedPromises) {
    const chunkResults = await Promise.all(chunk);
    results.push(...chunkResults);
    if (opt?.sleepMS) await sleep(opt.sleepMS);
  }
  return results;
}

export function chunk<T>(data: T[], maxItems: number): T[][] {
  if (!Array.isArray(data)) return [data];
  if (!maxItems) return [data];

  const chunkSize = Math.ceil(maxItems);
  if (data.length <= chunkSize) return [data.slice()];

  const chunks: T[][] = [];
  let index = 0;
  while (index < data.length) {
    chunks.push(data.slice(index, index + chunkSize));
    index = index + chunkSize;
  }
  return chunks;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
