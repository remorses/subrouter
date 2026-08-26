#!/usr/bin/env node
/** Runs the subrouter CLI binary. */

import { cli } from './cli.ts'

cli.parse(process.argv).catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(message + '\n')
  process.exit(1)
})
