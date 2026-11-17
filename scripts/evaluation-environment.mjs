import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectEvaluationEnvironment } from './lib/evaluation-environment.mjs';

export async function main(argv = process.argv.slice(2)) {
  const values = new Map();
  const flags = new Set([
    '--output',
    '--requested-acceleration',
    '--inference-threads',
    '--model-state',
  ]);
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flags.has(flag) || !value || value.startsWith('--') || values.has(flag)) {
      throw new Error(`Invalid or duplicate evaluation environment option: ${flag}`);
    }
    values.set(flag, value);
  }
  const environment = await collectEvaluationEnvironment({
    requestedAcceleration: values.get('--requested-acceleration'),
    inferenceThreads: values.has('--inference-threads')
      ? Number(values.get('--inference-threads'))
      : undefined,
    modelState: values.get('--model-state'),
  });
  const json = `${JSON.stringify(environment, null, 2)}\n`;
  if (values.has('--output')) {
    const output = resolve(values.get('--output'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json);
  } else {
    process.stdout.write(json);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
