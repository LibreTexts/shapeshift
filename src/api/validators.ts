import zod, { ZodObject, ZodError } from 'zod';
import { Request, Response, NextFunction } from 'express';
const jobIdSchema = zod.string().length(12);

export const validators = {
  job: {
    create: zod.object({
      body: zod.object({
        highPriority: zod.boolean(),
        url: zod.url(),
      }),
    }),
    get: zod.object({
      params: zod.object({
        jobId: jobIdSchema,
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
        throw new Error('Validation failed');
      }

      next();
    } catch (err) {
      return res.status(400).send({
        status: 400,
        errors: validationErrors,
      });
    }
  };
}
