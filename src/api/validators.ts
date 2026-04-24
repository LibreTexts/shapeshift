import zod, { ZodObject, ZodError } from 'zod';
import { Request, Response, NextFunction } from 'express';

const bookIDSchema = zod.stringFormat('BookID', /[a-z1-2]{3,9}[-][0-9]{2,10}/i);
const jobIDSchema = zod.uuidv4();

export const validators = {
  jobs: {
    list: zod.object({
      query: zod.object({
        limit: zod.coerce.number().int().nonnegative().default(100),
        offset: zod.coerce.number().int().nonnegative().default(0),
        sort: zod.enum(['asc', 'desc']).default('desc'),
        status: zod
          .preprocess(
            (val) => (typeof val === 'string' ? val.split(',') : val),
            zod.array(zod.enum(['created', 'inprogress', 'failed', 'finished'])),
          )
          .optional(),
      }),
    }),
  },
  download: {
    get: zod.object({
      params: zod.object({
        bookID: bookIDSchema,
        format: zod.enum(['pdf', 'epub', 'thincc', 'pages', 'publication']),
      }),
    }),
  },
  job: {
    create: zod.object({
      body: zod.object({
        highPriority: zod.boolean().optional(),
        url: zod.url(),
      }),
    }),
    get: zod.object({
      params: zod.object({
        jobID: jobIDSchema,
      }),
    }),
  },
};

function extractZodErrorMessages(validationResult: ZodError): string[] {
  const errors: string[] = [];
  for (const error of validationResult.issues) {
    errors.push(error.message);
  }
  return errors;
}

export function validateZod(schema: ZodObject) {
  return async (req: Request, res: Response, next: NextFunction) => {
    let validationErrors: string[] = [];
    try {
      const validationRes = await schema.safeParseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });

      if (!validationRes.success) {
        validationErrors = extractZodErrorMessages(validationRes.error);
        if (process.env.NODE_ENV === 'development') {
          console.error('Validation errors:', validationErrors);
        }
        throw new Error('Validation failed');
      }

      // Store validated/transformed data in a custom property
      (req as any).validatedData = validationRes.data;

      next();
    } catch (err) {
      return res.status(400).send({
        status: 400,
        errors: validationErrors,
      });
    }
  };
}
