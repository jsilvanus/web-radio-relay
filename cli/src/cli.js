#!/usr/bin/env node
/**
 * web-radio-relay — remote CLI for the relay API.
 *
 *   web-radio-relay ops                              list operations
  * web-radio-relay getStatus --server https://radio.example.com
  * web-radio-relay setDelay --body '{"delaySeconds":20}' --token $RELAY_TOKEN
  * web-radio-relay publishCaptions --body-file captions.json
 *
 * Options: --server (or RELAY_URL), --token (or RELAY_TOKEN),
 * --body JSON | --body-file path, and --<name> value for each parameter.
 */
import fs from 'node:fs';
import { operations } from './operations.generated.js';
import { callOperation } from './client.js';

/**
 * Split argv into the operation name, options, and parameter flags.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = { command: null, flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out.flags[key] = 'true';
      else { out.flags[key] = next; i++; }
    } else if (out.command === null) {
      out.command = arg;
    }
  }
  return out;
}

function usage() {
  return [
    'usage: web-radio-relay <operationId> [options]',
    '       web-radio-relay ops',
    '',
    'options:',
    '  --server URL      relay base URL (or RELAY_URL)',
    '  --token TOKEN     Bearer token for control routes (or RELAY_TOKEN)',
    '  --body JSON       request body',
    '  --body-file PATH  request body from a JSON file',
    '  --<param> VALUE   path or query parameter',
  ].join('\n');
}

/**
 * Run the CLI. Returns the process exit code.
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, stdout?: { write(s: string): void }, stderr?: { write(s: string): void }, fetchImpl?: typeof fetch }} [io]
 */
export async function run(argv, io = {}) {
  const env = io.env || process.env;
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { command, flags } = parseArgs(argv);

  if (!command || command === 'help' || flags.help) {
    stdout.write(usage() + '\n');
    return command ? 0 : 1;
  }
  if (command === 'ops') {
    for (const op of operations) stdout.write(`${op.operationId.padEnd(22)} ${op.method.padEnd(6)} ${op.path}\n`);
    return 0;
  }

  const op = operations.find((o) => o.operationId === command);
  if (!op) {
    stderr.write(`unknown operation "${command}" (try: web-radio-relay ops)\n`);
    return 2;
  }

  const server = flags.server || env.RELAY_URL;
  if (!server) {
    stderr.write('no server: pass --server or set RELAY_URL\n');
    return 2;
  }

  let body;
  try {
    if (flags['body-file']) body = JSON.parse(fs.readFileSync(flags['body-file'], 'utf8'));
    else if (flags.body) body = JSON.parse(flags.body);
  } catch (err) {
    stderr.write(`body is not valid JSON: ${err.message}\n`);
    return 2;
  }

  const params = {};
  for (const p of op.parameters) if (flags[p.name] !== undefined) params[p.name] = flags[p.name];

  try {
    const result = await callOperation(op, {
      server,
      token: flags.token || env.RELAY_TOKEN,
      params,
      body,
      fetchImpl: io.fetchImpl,
    });
    const printable = typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2);
    (result.ok ? stdout : stderr).write(printable + '\n');
    return result.ok ? 0 : 1;
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
