import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { connectDatabase } from '../model';
import { router } from '../api/routes';
import { log as logService } from '../lib/log';
import { APIWorkerEnvironment } from '../lib/apiWorkerEnvironment';

const app = express();
const port = process.env.PORT ? Number.parseInt(process.env.PORT) : 5000;

app.use(helmet.hidePoweredBy());
app.use('/api/v1', router);
app.use('/health', (_req, res) => res.send({ healthy: true, msg: 'API worker appears healthy.' }));

const logger = logService.child().withContext({ logSource: 'API worker' });
const server = app.listen(port, async () => {
  APIWorkerEnvironment.getEnvironment(); // verify environment before continuing
  await connectDatabase();
  console.log(`Shapeshift API worker listening on ${port}.`);
});

server.on('error', (err: Error) => logger.error(err.message));

function shutdown() {
  if (server.listening) {
    console.log('Attempting graceful shutdown of Shapeshift API worker...');
    server.close(async () => {
      console.log('Shapeshift API worker shutdown successfully.');
    });
  }
}

// Register shutdown signal listeners
const signals = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };
Object.keys(signals).forEach((signal) => process.on(signal, shutdown));
