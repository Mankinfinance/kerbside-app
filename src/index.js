// Entry point: wires config, storage and the Square gateway, then starts the server.
import { config } from './config.js';
import { openDb } from './db.js';
import { buildServer } from './server.js';
import { createFakeGateway } from './square/fake-gateway.js';
import { createSquareHttpGateway } from './square/http-gateway.js';

const db = openDb(config.dbPath);
const gateway = config.gateway === 'square' ? createSquareHttpGateway(config.square) : createFakeGateway();
// Order tokens can appear in event-stream URLs, so they are redacted from request logs.
const logger = {
  level: process.env.LOG_LEVEL || 'info',
  serializers: { req: (req) => ({ method: req.method, url: String(req.url).replace(/token=[^&]+/g, 'token=[redacted]') }) },
};
const app = buildServer({ db, gateway, config, logger });

if (gateway.kind === 'fake') app.log.warn('Running with the FAKE Square gateway. Test cards only; nothing is charged. Set GATEWAY=square for Square.');

// Release held orders whose customer never tapped "Leaving now".
const timer = setInterval(() => app.orders.releaseExpiredHolds().catch((e) => app.log.error(e)), 60_000);
const stop = async () => { clearInterval(timer); await app.close(); db.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await app.listen({ port: config.port, host: config.host });
