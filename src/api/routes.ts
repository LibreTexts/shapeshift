import cors from 'cors';
import express from 'express';
import { Environment } from '../lib/environment';
import { JobController } from '../controllers/job';
import { validateZod, validators } from './validators';
import { DownloadController } from '../controllers/download';
import zod from 'zod';
import { ZodRequest } from '../helpers';

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

export { router };
