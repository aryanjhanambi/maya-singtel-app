import { createAgentsApi } from './agents-api.js';
import { loadEnvFile, readConfig } from './config.js';
import { createApp } from './http.js';
import { Journal } from './store.js';

loadEnvFile();
const config = readConfig();

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function log(level, message) {
  if ((LEVELS[level] ?? 20) < (LEVELS[config.logLevel] ?? 20)) return;
  console.log(`[maya] ${level} ${message}`);
}

const api = config.apiKey
  ? createAgentsApi({ apiKey: config.apiKey, baseUrl: config.baseUrl })
  : null;
const app = createApp({ config, api, journal: new Journal(config.dataDir), log });

app.server.listen(config.port, config.host, () => {
  log('info', `Maya demo at http://${config.host}:${config.port}`);
  log(
    'info',
    api
      ? `Agents API configured (model ${config.model})`
      : 'OPENAI_API_KEY is not set: the app shows its setup state and contacts nothing',
  );
  log(
    'info',
    config.codeReleaseEnabled
      ? 'Code release is ARMED: a staged test code can be released after typed confirmation'
      : 'Code release is locked (rehearsal): the app will not accept a test code',
  );
  log('info', `Browser: Chromium run by this app with Playwright (${config.browserHeadless ? 'headless' : 'headed'}); Maya may use ${config.allowedHosts.join(', ')}`);
  if (config.fixtureMode) log('warn', 'Not using the OpenAI endpoint: the UI is labelled as a fixture');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // Remote sessions are left in place so the owner can reattach after a restart.
    log('info', 'Shutting down. The browser closes with the app. Any open Agents API session is kept, not deleted.');
    app.close().then(() => process.exit(0));
  });
}
