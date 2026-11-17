import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sidecarFeatures } from './lib/sidecar-features.mjs';

export function buildRustQualityCommands(environment = process.env) {
  return [
    {
      args: ['fmt', '--manifest-path', 'native/Cargo.toml', '--check'],
      command: 'cargo',
      env: environment,
    },
    {
      args: [
        'clippy',
        '--locked',
        '--manifest-path',
        'native/Cargo.toml',
        '--all-targets',
        '--features',
        sidecarFeatures(),
        '--',
        '-D',
        'warnings',
      ],
      command: 'cargo',
      env: { ...environment, DOCS_RS: '1' },
    },
    {
      args: [
        'test',
        '--locked',
        '--manifest-path',
        'native/Cargo.toml',
        '--features',
        sidecarFeatures(),
      ],
      command: 'cargo',
      env: environment,
    },
  ];
}

function main() {
  for (const command of buildRustQualityCommands()) {
    execFileSync(command.command, command.args, {
      stdio: 'inherit',
      env: command.env,
    });
  }
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href;

if (isDirectInvocation) {
  main();
}
