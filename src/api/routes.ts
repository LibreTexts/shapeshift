import cors from 'cors';
import express from 'express';
import { getEnvironment } from '../lib/environment';
import { JobController } from '../controllers/job';
import { validateZod, validators } from './validators';

// <API routes>
const router = express.Router();
router.use(
  cors({
    origin(origin, callback) {
      const env = getEnvironment();

      // Allow same-origin requests or all in development
      if (!origin || env === 'DEVELOPMENT') return callback(null, true);

      if (origin.endsWith('.libretexts.org')) return callback(null, origin);
      return callback(new Error('CORS policy: Not allowed by CORS'));
    },
    methods: ['GET', 'PUT', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'Content-Type', 'Authorization'],
    maxAge: 7200,
  }),
);
router.route('/job').post(validateZod(validators.job.create), async (req, res) => {
  const jobController = new JobController();
  return await jobController.create(req, res);
});
router.route('/job/:jobId').get(validateZod(validators.job.get), async (req, res) => {
  const jobController = new JobController();
  return await jobController.get(req, res);
});

export { router };
