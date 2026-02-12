import cors from 'cors';
import express from 'express';
import { Environment } from '../lib/environment';
import { JobController } from '../controllers/job';
import { validateZod, validators } from './validators';
import { DownloadController } from '../controllers/download';
import zod from 'zod';
import { ZodRequest } from '../helpers';
import { QueueClient } from '../lib/queueClient';

// <API routes>
const router = express.Router();
const jobController = new JobController();
const downloadController = new DownloadController();

router.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin requests or all in development
      if (!origin || Environment.getSystemEnvironment() === 'DEVELOPMENT') return callback(null, true);

      if (origin.endsWith('.libretexts.org')) return callback(null, origin);
      return callback(new Error('CORS policy: Not allowed by CORS'));
    },
    methods: ['GET', 'PUT', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'Content-Type', 'Authorization'],
    maxAge: 7200,
  }),
);
router
  .route('/download/:bookID/:format/:fileName')
  .get(validateZod(validators.download.get), (req, res) =>
    downloadController.downloadFile(req as ZodRequest<zod.infer<typeof validators.download.get>>, res),
  );
router.route('/job').post(validateZod(validators.job.create), (req, res) => jobController.create(req, res));
router.route('/job/:jobID').get(validateZod(validators.job.get), (req, res) => jobController.get(req, res));

router.route('/clear-queue').post(async (req, res) => {
  if (Environment.getSystemEnvironment() !== 'DEVELOPMENT') {
    return res.status(501).send({
      msg: 'Clearing the queue is only allowed in development environment.',
      status: 501,
    });
  }

  const queueClient = new QueueClient();
  await queueClient.clearQueue();
  return res.status(200).send({
    msg: 'Queue cleared successfully.',
    status: 200,
  });
});

export { router };

// Extend Express Request type to include validated data
declare global {
  namespace Express {
    interface Request {
      validatedData?: {
        body?: any;
        query?: any;
        params?: any;
      };
    }
  }
}
