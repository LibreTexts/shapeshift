import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { connectDatabase } from '../model';
import { router } from '../api/routes';
import { log as logService } from '../lib/log';
import { Environment } from '../lib/environment';

Environment.load();
const app = express();
const port = Number.parseInt(Environment.getOptional('PORT', '5000'));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 100, // limit requests/IP address/windowMs
  keyGenerator: (req) => {
    const forwardFor = req.headers['x-forwarded-for'];
    if (forwardFor && typeof forwardFor === 'string') {
      const ips = forwardFor.split(',').map((ip) => ip.trim());
      if (ips.length > 0) {
        return ipKeyGenerator(ips[0]); // Use the first IP in the list
      }
    }

    return ipKeyGenerator(req.ip || ''); // Fallback to req.ip if no X-Forwarded-For header
  },
});

app.use(express.json());
app.use(helmet.hidePoweredBy());
app.use('/api/v1', apiLimiter, router);
app.use('/health', (_req, res) => res.send({ healthy: true, msg: 'API worker appears healthy.' }));

const logger = logService.child().withContext({ logSource: 'API worker' });
const server = app.listen(port, async () => {
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
