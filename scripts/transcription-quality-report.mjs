#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { collectEvaluationEnvironment } from './lib/evaluation-environment.mjs';

import {
  buildQualityReport,
  parseQualityMeasurements,
  renderQualityReportMarkdown,
} from './lib/transcription-quality-report.mjs';

export function parseArgs(argv) {
  const args = {
    outputDir: 'artifacts/transcription-quality',
    renderOnly: null,
    environment: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case '--output-dir':
        index += 1;
        args.outputDir = argv[index];
        break;
      case '--render-only':
        index += 1;
        args.renderOnly = argv[index];
        break;
      case '--environment':
        index += 1;
        args.environment = argv[index];
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  if (
    !args.outputDir ||
    (argv.includes('--render-only') && !args.renderOnly) ||
    (argv.includes('--environment') && !args.environment)
  ) {
    throw new Error('--output-dir, --render-only and --environment require a path.');
  }
  return args;
}

async function qualityInputFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await qualityInputFiles(path)));
    if (
      entry.isFile() &&
      (entry.name.endsWith('.jsonl') || entry.name.endsWith('.environment.json'))
    )
      files.push(path);
  }
  return files.sort();
}

async function readEnvironment(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (value?.schemaVersion !== 1 || !value.host || !value.execution) {
    throw new Error(`Invalid evaluation environment: ${path}`);
  }
  return value;
}

async function render(inputDirectory, outputDirectory, environment = null) {
  const inputs = await qualityInputFiles(inputDirectory);
  const files = inputs.filter((file) => file.endsWith('.jsonl'));
  const measurements = [];
  const environments = [];
  const missingMeasurementSources = [];
  const contextSources = new Map();
  for (const contextFile of inputs.filter((file) => file.endsWith('.environment.json'))) {
    const source = relative(inputDirectory, contextFile).replaceAll('\\', '/');
    environments.push({ source, context: await readEnvironment(contextFile) });
    const measurementFile = contextFile.replace(/\.environment\.json$/u, '.jsonl');
    contextSources.set(measurementFile, source);
    if (!files.includes(measurementFile))
      missingMeasurementSources.push(
        relative(inputDirectory, measurementFile).replaceAll('\\', '/'),
      );
  }
  for (const file of files) {
    const cases = parseQualityMeasurements(await readFile(file, 'utf8'), basename(file));
    if (contextSources.has(file))
      for (const measurement of cases) measurement.environmentSource = contextSources.get(file);
    measurements.push(...cases);
  }
  const report = buildQualityReport(measurements, {
    commitSha: process.env.GITHUB_HEAD_SHA ?? process.env.GITHUB_SHA ?? null,
    generatedAt: new Date().toISOString(),
    runner: process.env.RUNNER_DESCRIPTION ?? null,
    environment,
    environments,
    missingMeasurementSources,
  });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    join(outputDirectory, 'transcription-quality.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(
    join(outputDirectory, 'transcription-quality.md'),
    renderQualityReportMarkdown(report),
  );
  return report;
}

function runSuite(script, reportPath) {
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(command, ['run', script], {
    env: { ...process.env, STT_QUALITY_REPORT_PATH: reportPath },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${script} failed with exit status ${result.status}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      'Usage: node scripts/transcription-quality-report.mjs [--output-dir <dir>] [--render-only <measurement-dir>] [--environment <recorded-context.json>]',
    );
    return;
  }
  const outputDirectory = resolve(args.outputDir);
  const recordedEnvironment = args.environment
    ? await readEnvironment(resolve(args.environment))
    : null;
  if (args.renderOnly !== null) {
    await render(resolve(args.renderOnly), outputDirectory, recordedEnvironment);
    return;
  }

  await rm(outputDirectory, { force: true, recursive: true });
  const measurementDirectory = join(outputDirectory, 'measurements');
  await mkdir(measurementDirectory, { recursive: true });
  const environment =
    recordedEnvironment ??
    (await collectEvaluationEnvironment({ requestedAcceleration: 'cpu', modelState: 'mixed' }));
  await writeFile(
    join(outputDirectory, 'evaluation-environment.json'),
    `${JSON.stringify(environment, null, 2)}\n`,
  );
  try {
    for (const [script, filename] of [
      ['test:sidecar:e2e', 'whisper-english.jsonl'],
      ['test:sidecar:nemotron:e2e', 'nemotron-english.jsonl'],
      ['test:sidecar:multilingual:e2e', 'multilingual.jsonl'],
    ]) {
      runSuite(script, join(measurementDirectory, filename));
    }
  } catch (suiteError) {
    // Failed acceptance checks still produce useful measurements. A build or
    // startup failure may produce none; keep the original failure authoritative.
    try {
      await render(measurementDirectory, outputDirectory, environment);
    } catch (reportError) {
      console.error('Could not render partial transcription measurements:', reportError.message);
    }
    throw suiteError;
  }
  await render(measurementDirectory, outputDirectory, environment);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
