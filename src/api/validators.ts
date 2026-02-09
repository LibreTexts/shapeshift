import zod, { ZodObject, ZodError } from 'zod';
import { Request, Response, NextFunction } from 'express';

const bookIDSchema = zod.stringFormat('BookID', /[a-z1-2]{3,9}[-][0-9]{2,10}/gi);
const jobIDSchema = zod.string().length(12);

export const validators = {
  download: {
    get: zod.object({
      params: zod.object({
        bookID: bookIDSchema,
        fileName: zod.enum(['LibreText.imscc', 'Publication.zip', 'Full.pdf']), // FIXME: define all
        format: zod.enum(['pdf', 'thincc']),
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

      // Assign the validated/transformed data back to the request object for use in route handlers
      req.body = validationRes.data.body;
      req.query = validationRes.data.query as typeof req.query;
      req.params = validationRes.data.params as typeof req.params;

      next();
    } catch (err) {
      return res.status(400).send({
        status: 400,
        errors: validationErrors,
      });
    }
  };
}
