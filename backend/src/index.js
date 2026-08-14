import { createRelayServer } from './app.js';
import { loadConfig } from './config.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(JSON.stringify({ level: 'error', event: 'startup_failed', message: error.message }));
  process.exitCode = 1;
}

if (config) {
  const relay = createRelayServer({ config });
  relay.server.listen(config.port, config.host, () => {
    const address = relay.server.address();
    console.log(JSON.stringify({
      level: 'info',
      event: 'relay_started',
      address: typeof address === 'object' && address ? address.address : config.host,
      port: typeof address === 'object' && address ? address.port : config.port,
      storage: 'memory',
    }));
  });

  let stopping = false;
  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ level: 'info', event: 'relay_stopping', signal }));
    await relay.shutdown();
    process.exitCode = 0;
  }
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
}
