/**
 * Failures whose message is written for the person who submitted the book.
 *
 * `Job.failureReason` is readable over `GET /job/:jobID`, which is unauthenticated, so whatever
 * lands in that column is public. Most of what the pipeline throws is not safe to put there: an S3
 * client error names the bucket and key, an SQS error names the queue URL and the AWS account, a
 * Sequelize error names columns, a filesystem error names container paths.
 *
 * Rather than trying to scrub those after the fact, the column is allowlisted by provenance. A
 * message reaches it verbatim only when the pipeline composed it deliberately as a diagnosis, which
 * is what throwing this class asserts. Everything else is replaced with a generic line and the real
 * error goes to the logs (see `JobService.fail`).
 *
 * The rule for adding a `throw new ExportFailure(...)`: the message must be assembled from the
 * book's own content — page URLs, group file names, page counts, HTTP status codes from public
 * LibreTexts endpoints — and never from an error object this codebase did not construct.
 */
export class ExportFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportFailure';
  }
}

/**
 * Message text for an error that is going to be shown to the submitter.
 *
 * Returns the real message only for an `ExportFailure`. Anything else collapses to `fallback`,
 * which the caller supplies as a description of *where* the failure happened. That keeps the
 * summary useful ("Chapter_3: conversion failed") without letting an arbitrary error's text through.
 */
export function safeFailureText(error: unknown, fallback: string): string {
  return error instanceof ExportFailure ? error.message : fallback;
}
