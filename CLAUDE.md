# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About Shapeshift

A scalable, distributed system for extracting and transforming LibreTexts content (hosted on the Mindtouch/NICE CXOne platform) into export formats like PDF and EPUB. It runs as two separate workers: an Express API and a background job processor.

## Commands

```bash
# Development
npm run dev:api           # Run API worker with hot reload
npm run dev:processor     # Run processor worker with hot reload

# Build
npm run build             # Compile TypeScript to ./build (also copies src/styles)

# Lint
npm run lint              # ESLint check
npm run lint-and-fix      # ESLint with auto-fix
npm run prettier          # Format all .ts files

# Database
npm run sync-db-schema    # Sync Sequelize models to DB

# No tests are currently implemented
```

### Docker Development

```bash
# Start ephemeral MySQL only
docker compose -f docker-compose-mysql.dev.yml up -d

# Start full stack (MySQL + API + Processor)
docker compose -f docker-compose.dev.yaml up -d

# Build and run with local changes (uses run-dev-build.sh)
./run-dev-build.sh
```

### Test a job request

```bash
curl --request POST \
  --url http://localhost:80/api/v1/job \
  --header 'content-type: application/json' \
  --data '{"url":"https://dev.libretexts.org/Sandboxes/eaturner_at_ucdavis.edu/Test_Book","highPriority":false}'
```

## Architecture

### Dual-Worker Design

Two separate Node.js processes with separate Docker images:

- **`src/workers/api.ts`** — Express 5 server (default port 5000). Validates requests via Zod, persists jobs to MySQL, enqueues job messages to AWS SQS.
- **`src/workers/processor.ts`** — Polls SQS queues continuously, processes one job at a time, uploads results to S3. Messages are deleted immediately (no SQS retries); failures are recorded in the DB.

### Job Lifecycle

```
POST /api/v1/job
  → JobController → JobService.create() (MySQL, status: "created")
  → QueueClient.sendJobMessage() (SQS)
  → Processor picks up message
  → JobService.run() (status: "inprogress")
  → BookService (fetches pages from CXOne API) + PDFService or EPUBService
  → StorageService (uploads to S3, status: "finished")

GET /api/v1/download/:bookID/:format/:fileName
  → DownloadController → CloudFront signed URL redirect
```

### Key Directories

- **`src/api/`** — Express route definitions + Zod validation schemas
- **`src/controllers/`** — HTTP request handlers (`job.ts`, `download.ts`)
- **`src/services/`** — Core business logic: `job.ts` (orchestration), `book.ts` (page discovery), `pdf.ts` (Prince XML), `epub.ts` (EPUB packaging), `library.ts` (CXOne API client)
- **`src/lib/`** — Infrastructure clients: `queueClient.ts` (SQS), `storageService.ts` (S3), `environment.ts` (env var access), `cxOneRateLimiter.ts`
- **`src/util/`** — Stateless helpers (MathJax rendering, PDF utilities, licensing, page IDs)
- **`src/CXOne/`** — LibreTexts CXOne Expert API integration
- **`src/model/`** — Sequelize-TypeScript ORM models (`Job`)
- **`src/lambda/`** — AWS Lambda for CloudWatch backlog-per-instance metrics
- **`src/styles/`** — CSS copied into build output, used for PDF rendering

### Validation Pattern

All API routes use a shared `validateZod` middleware that attaches the validated payload to `req.data`. Handlers are typed as `ZodRequest<T>` for downstream type safety. Zod schemas live in `src/api/`.

### AWS Dependencies

- **SQS**: Two queues (standard + high-priority), polled with 20s long-poll wait
- **S3**: Output file storage; downloads served via CloudFront signed URLs
- **SSM Parameter Store**: Credential management in production
- **LocalStack**: Use for local AWS emulation (`LOCALSTACK_HOST`/`LOCALSTACK_PORT` env vars)

### Environment

See `.env.example` for all variables. Key required vars: `AWS_REGION`, `BUCKET`, `CLOUDFRONT_*`, `SQS_*_QUEUE_URL`, `NODE_ENV`. Database vars (`DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB`) are optional and support read replicas (`*_READ` variants).

## Code Style

- TypeScript strict mode; decorators enabled for Sequelize models (`experimentalDecorators`, `emitDecoratorMetadata`)
- Prettier: 120-char line width, single quotes, 2-space indent, trailing commas
- `@typescript-eslint/no-explicit-any` is disabled — `any` is permitted
- Commits follow Conventional Commits (enforced by commitlint + Husky)
