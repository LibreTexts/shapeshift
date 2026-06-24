import { z } from './zodOpenapi';
import { OpenAPIRegistry, OpenApiGeneratorV3, ResponseConfig } from '@asteasolutions/zod-to-openapi';
import { validators, _jobStatusSchema, _exportFormatSchema } from './validators';

const EXAMPLE_BOOK_URL = 'https://phys.libretexts.org/Bookshelves/Classical_Mechanics/Classical_Mechanics_(Tatum)';

export const registry = new OpenAPIRegistry();

// --- Security scheme ---------------------------------------------------------------------------
const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description: 'API key issued by an administrator.',
});

// --- Reusable component schemas ----------------------------------------------------------------
registry.register('JobStatus', _jobStatusSchema);
registry.register('ExportFormat', _exportFormatSchema);

const JobSchema = registry.register(
  'Job',
  z.object({
    id: z.string().openapi({ example: 'abc123xyz012' }),
    status: _jobStatusSchema,
    isHighPriority: z.boolean(),
    url: z.url().openapi({ example: EXAMPLE_BOOK_URL }),
    createdAt: z.string().openapi({ format: 'date-time' }),
  }),
);

const ErrorResponse = registry.register(
  'ErrorResponse',
  z.object({
    msg: z.string(),
    status: z.number().int(),
  }),
);

// --- Request schemas: reuse the runtime validators, layering doc-only metadata on top ----------
// `.extend()` swaps individual fields for `.openapi()`-annotated clones of the same field type, so
// the request shape stays sourced from `validators` (no duplication of validation logic).
const jobCreateBody = validators.job.create.shape.body.extend({
  url: validators.job.create.shape.body.shape.url.openapi({
    description: 'Full URL of the LibreTexts book to export.',
    example: EXAMPLE_BOOK_URL,
  }),
  highPriority: validators.job.create.shape.body.shape.highPriority.openapi({
    description: 'Route the job to the high-priority queue.',
    default: false,
  }),
});

const jobGetParams = validators.job.get.shape.params.extend({
  jobID: validators.job.get.shape.params.shape.jobID.openapi({
    description: 'Job identifier (UUID v4) returned by POST /job.',
    example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  }),
});

// `bookID` is a custom `stringFormat('BookID', ...)`, which would otherwise emit a non-standard
// `format: "BookID"`. Override with an explicit string + pattern for portable docs.
const downloadParams = validators.download.get.shape.params.extend({
  bookID: validators.download.get.shape.params.shape.bookID.openapi({
    type: 'string',
    pattern: '^[a-z1-2]{3,9}-[0-9]{2,10}$',
    description: 'Library-prefixed book identifier (e.g. `phys-12345`).',
    example: 'phys-123456',
  }),
  format: validators.download.get.shape.params.shape.format.openapi({
    description: 'Export format.',
  }),
});

// `status` uses `zod.preprocess()` (comma-split) at runtime, which does not render as a clean query
// param. Document it as the comma-separated string clients actually send.
const jobsListQuery = validators.jobs.list.shape.query.extend({
  status: z.string().optional().openapi({
    description: 'Comma-separated job statuses to filter by.',
    example: 'created,finished',
  }),
});

// --- Helpers -----------------------------------------------------------------------------------
function jsonResponse(description: string, schema: z.ZodType): ResponseConfig {
  return { description, content: { 'application/json': { schema } } };
}

const statusField = z.number().int().openapi({ example: 200 });

// --- Paths -------------------------------------------------------------------------------------
// TODO: add type checking to the endpoints to ensure theyactually return the matching response schemas
registry.registerPath({
  method: 'post',
  path: '/job',
  summary: 'Submit an export job',
  description: 'Enqueues a new export job for the given LibreTexts book URL.',
  tags: ['Jobs'],
  request: {
    body: { required: true, content: { 'application/json': { schema: jobCreateBody } } },
  },
  responses: {
    200: jsonResponse(
      'Job created successfully.',
      z.object({
        data: z.object({
          id: z.string().openapi({ example: 'abc123xyz012' }),
          status: z.string().openapi({ example: 'created' }),
        }),
        status: statusField,
      }),
    ),
    400: jsonResponse('Invalid request body.', ErrorResponse),
  },
});

registry.registerPath({
  method: 'get',
  path: '/job/{jobID}',
  summary: 'Get a job by ID',
  description: 'Returns the current status and metadata for a single export job.',
  tags: ['Jobs'],
  request: { params: jobGetParams },
  responses: {
    200: jsonResponse(
      'Job found.',
      z.object({
        data: z.object({
          bookID: z.string(),
          id: z.string(),
          isHighPriority: z.boolean(),
          status: _jobStatusSchema,
          url: z.url(),
        }),
        status: statusField,
      }),
    ),
    400: jsonResponse('Invalid job ID format.', ErrorResponse),
    404: jsonResponse('Job not found.', ErrorResponse),
  },
});

registry.registerPath({
  method: 'get',
  path: '/jobs',
  summary: 'List open jobs',
  description: 'Returns a list of jobs filtered by status. Requires a valid API key.',
  tags: ['Jobs'],
  security: [{ [bearerAuth.name]: [] }],
  request: { query: jobsListQuery },
  responses: {
    200: jsonResponse(
      'List of jobs.',
      z.object({
        meta: z.object({
          offset: z.number().int(),
          limit: z.number().int(),
          total: z.number().int(),
        }),
        data: z.array(JobSchema),
        status: statusField,
      }),
    ),
    401: jsonResponse('Missing or invalid API key.', ErrorResponse),
  },
});

registry.registerPath({
  method: 'get',
  path: '/download/{bookID}/{format}',
  summary: 'Download an exported file',
  description: 'Redirects (302) to a short-lived signed CloudFront URL for the requested export file.',
  tags: ['Downloads'],
  request: { params: downloadParams },
  responses: {
    302: {
      description: 'Redirect to signed CloudFront download URL.',
      headers: z.object({
        Location: z.string().openapi({ description: 'Signed CloudFront URL (valid for 5 minutes).' }),
      }),
    },
    400: jsonResponse('Invalid path parameters.', ErrorResponse),
    404: jsonResponse('File not found in storage.', ErrorResponse),
  },
});

// --- Document generation -----------------------------------------------------------------------
export function generateOpenApiDocument() {
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'LibreTexts Shapeshift API',
      description: 'API for submitting and tracking LibreTexts content export jobs (PDF, EPUB, etc.).',
      version: '1.0.0',
    },
    servers: [{ url: '/api/v1' }],
  });
}
