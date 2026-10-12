#!/usr/bin/env node
/**
 * `wb-connect` entry point.
 *
 * Exists only to turn argv into an exit code; every command lives in `cli.js`
 * so the same surface is reachable from a script that imports this package.
 */

import { main } from '../src/cli.js'

main(process.argv.slice(2))
  .then((code) => {
    // `serve` never resolves on its own, so a resolved promise means the
    // process is done and the exit code is authoritative.
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
