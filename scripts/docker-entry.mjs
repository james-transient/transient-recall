#!/usr/bin/env node
import { spawn } from 'node:child_process';

async function run() {
  const migrate = spawn('node', ['scripts/migrate.mjs'], {
    stdio: 'inherit',
    env: process.env
  });
  const migrateExit = await new Promise((resolve) => migrate.on('close', resolve));
  if (migrateExit !== 0) {
    process.exit(migrateExit);
  }

  const server = spawn('node', ['src/index.mjs'], {
    stdio: 'inherit',
    env: process.env
  });
  server.on('close', (code) => process.exit(code ?? 0));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
