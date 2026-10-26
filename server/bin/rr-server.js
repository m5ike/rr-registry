#!/usr/bin/env node
'use strict';
// RR Registry server entry point.
//   node server/bin/rr-server.js [--port N] [--data DIR] [--host H]
const { App } = require('../src/server');

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--port' || a === '-p') opt.port = Number(args[++i]);
  else if (a === '--data' || a === '-d') opt.dataDir = require('path').resolve(args[++i]);
  else if (a === '--host') opt.host = args[++i];
  else if (a === '--help' || a === '-h') {
    console.log('Usage: rr-server [--port N] [--host H] [--data DIR]\nConfiguration via .env / RR_* environment variables (see README).');
    process.exit(0);
  }
}

const app = new App(opt);
if (app.config.adminPassword === 'admin') app.log.warn('RR_ADMIN_PASSWORD is the default "admin" - run `make menuconfig` to change it');
app.listen().catch((e) => {
  console.error(e);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    app.log.info(`${sig} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}
