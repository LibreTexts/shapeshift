import { LogLayer } from 'loglayer';
import { Environment } from './environment';
import { log as logService } from './log';
import { Job } from '../model';
import type { JobOutputFormat } from '../services/job';

/**
 * Job progress reporting.
 *
 * A job is opaque to the caller: it sits on 'inprogress' for as long as the conversion takes,
 * which for a large book is tens of minutes. This module turns the pipeline's existing phase
 * boundaries into a 0-100 number and a stage label, persisted on the job row so the API worker
 * (a separate container from the processor) can read them back.
 *
 * Design rules, enforced here so no call site has to think about them:
 *   - Monotonic. The reported value never goes down, even when parallel work completes out of order.
 *   - Conservative. It is capped at 99 while running; only JobService.finish() writes 100.
 *   - Cheap. Writes are throttled to one every JOB_PROGRESS_MIN_WRITE_MS, and only when the
 *     integer percentage or the stage label actually changes.
 *   - Non-fatal. A failed progress write is logged and swallowed. Progress must never fail a job.
 *
 * Writes go straight to the `Job` model rather than through `JobService`, because `JobService`
 * imports this module — routing writes back through it would be a runtime import cycle.
 */

export type JobStageKey =
  | 'queued'
  | 'resolving'
  | 'discovering'
  | 'images'
  | 'math'
  | 'pdfPass1'
  | 'pdfPass2'
  | 'pdfFull'
  | 'pdfPages'
  | 'pdfPrint'
  | 'pdfCovers'
  | 'epub'
  | 'thincc'
  | 'finalizing';

type StageDefinition = {
  label: string;
  /**
   * Relative share of total wall clock. These sum to 100 for the full multi-format path and are
   * renormalized when a format is disabled. They are estimates: the per-stage durations logged by
   * the reporter are what they should be recalibrated against.
   */
  weight: number;
  /** Output format this stage belongs to. Stages for disabled formats are dropped from the plan. */
  format?: JobOutputFormat;
};

/**
 * Weighting is deliberately uneven. MathJax pre-rendering is sequential by necessity (a module
 * global in util/mathjax.ts), so its share grows linearly with page count, while the Prince passes
 * scale at 1/PRINCE_CONCURRENCY.
 */
const STAGES: Record<JobStageKey, StageDefinition> = {
  queued: { label: 'Queued', weight: 0 },
  resolving: { label: 'Resolving book', weight: 1 },
  discovering: { label: 'Discovering pages', weight: 10 },
  images: { label: 'Optimizing images', weight: 8, format: 'PDF' },
  math: { label: 'Rendering math', weight: 18, format: 'PDF' },
  pdfPass1: { label: 'Measuring page layout', weight: 14, format: 'PDF' },
  pdfPass2: { label: 'Building document', weight: 8, format: 'PDF' },
  pdfFull: { label: 'Generating PDF', weight: 10, format: 'PDF' },
  pdfPages: { label: 'Generating individual pages', weight: 8, format: 'PDF' },
  pdfPrint: { label: 'Generating print edition', weight: 10, format: 'PDF' },
  pdfCovers: { label: 'Generating covers', weight: 4, format: 'PDF' },
  epub: { label: 'Generating EPUB', weight: 6, format: 'EPUB' },
  thincc: { label: 'Generating Common Cartridge', weight: 1, format: 'ThinCC' },
  finalizing: { label: 'Finalizing', weight: 2 },
};

/** Execution order for a full book. Bands are laid out along this sequence. */
const FULL_STAGE_ORDER: JobStageKey[] = [
  'queued',
  'resolving',
  'discovering',
  'images',
  'math',
  'pdfPass1',
  'pdfPass2',
  'pdfFull',
  'pdfPages',
  'pdfPrint',
  'pdfCovers',
  'epub',
  'thincc',
  'finalizing',
];

/** The single-content-page shortcut in JobService.run() skips most of the PDF pipeline. */
const SINGLE_PAGE_STAGE_ORDER: JobStageKey[] = ['queued', 'resolving', 'discovering', 'math', 'pdfFull', 'finalizing'];

export const JOB_STAGE_LABELS = {
  queued: STAGES.queued.label,
  complete: 'Complete',
} as const;

/** Highest value reportable while a job is still running. Only finish() writes 100. */
export const MAX_INPROGRESS_PROGRESS = 99;

const DEFAULT_MIN_WRITE_INTERVAL_MS = 2000;
const CREEP_TICK_MS = 1000;
/**
 * How often a running job touches its row purely to prove it is alive. Well under the smallest
 * sane JOB_STALE_AFTER_MINUTES, so a job is never a single missed write away from being reaped.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Wall-clock budget for one job, measured from the moment the processor picks it up.
 *
 * This is the pipeline's own deadline, not the reaper's. Every open-ended phase checks it and
 * aborts the job when it is gone (see `PDFService.assertWithinJobBudget` and
 * `JobService.assertWithinBudget`), so a job that runs away fails itself and releases its book
 * deliberately rather than being taken away from it mid-write.
 */
export const JOB_MAX_DURATION_MS = 4 * 60 * 60 * 1000;

/**
 * How long the heartbeat keeps going after the budget is spent.
 *
 * Budget checks are discrete. A job only notices it is over at the next checkpoint, and whatever
 * is in flight at that moment — one Prince run over a whole book, a multi-gigabyte upload — has to
 * return first. The grace has to cover that overshoot plus the unwind, or the reaper releases the
 * book while the job is still on its way to failing itself, which is precisely the double-writer
 * case the heartbeat exists to prevent.
 *
 * Thirty minutes, not the hour it started at. The longest single uninterruptible step is one Prince
 * invocation over a whole book followed by its upload, and nothing observed comes close to half an
 * hour. The cost of the surplus is real and paid by the wrong party: every minute here is a minute
 * a wedged worker keeps its book unsubmittable, so the grace should cover the worst plausible
 * overshoot and stop there. Raise it only against a measured phase duration, never a guess.
 */
const HEARTBEAT_GRACE_MS = 30 * 60 * 1000;

/**
 * Absolute ceiling on how long one job may keep manufacturing liveness.
 *
 * The heartbeat exists so a book that legitimately runs long isn't reaped mid-flight, but it also
 * removes the only unconditional escape hatch the system had: before it existed, any row stuck on
 * 'inprogress' aged out and freed the book for resubmission. A worker wedged somewhere with no
 * checkpoint to reach — a TCP connect with no timeout, a stuck upload — would otherwise hold its
 * book hostage forever, so the ceiling stays.
 *
 * It sits deliberately *above* JOB_MAX_DURATION_MS rather than level with it. Set equal, the two
 * mechanisms race: the job trips its budget and the heartbeat quits in the same instant, so a job
 * unwinding from a long-running phase can still be reaped before it manages to write 'failed', and
 * a resubmission puts a second worker on the same S3 keys. The gap makes the ordering
 * unambiguous — a runaway job always fails itself first, and this ceiling only ever catches a
 * worker that is alive but stuck short of any checkpoint.
 *
 * Past this age the heartbeat stops and the row is allowed to go stale. Real progress writes still
 * land (they bump `updatedAt` too), so a job that is genuinely still working keeps its liveness;
 * only a silent one gets released.
 *
 * This is the number that sets the worst case for a book nobody can resubmit: 4h30m here, plus
 * JOB_STALE_AFTER_MINUTES before the reaper acts, so 4h45m at the default. It only applies to a
 * worker that is alive but stuck short of every checkpoint. A crashed or evicted container stops
 * beating immediately and its book comes back in the usual 15 minutes.
 */
const MAX_HEARTBEAT_AGE_MS = JOB_MAX_DURATION_MS + HEARTBEAT_GRACE_MS;
/** Creep stops this far into its band, so it can never collide with the next real checkpoint. */
const CREEP_BAND_CEILING = 0.9;

type StageBand = { key: JobStageKey; label: string; start: number; end: number };

export interface ProgressReporter {
  /**
   * Wall-clock milliseconds since the job started, or 0 when there is no job behind this reporter.
   * The pipeline measures JOB_MAX_DURATION_MS against it, so the budget covers everything the job
   * has done — page discovery, earlier formats — rather than only the service asking.
   */
  elapsedMs(): number;
  enter(stage: JobStageKey): void;
  expect(total: number): void;
  tick(count?: number): void;
  fraction(done: number, total: number): void;
  during<T>(stage: JobStageKey, estimateMs: number, fn: () => Promise<T>): Promise<T>;
  flush(): Promise<void>;
  stop(): void;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Lays the enabled stages out end to end across 0-100. Stages belonging to a disabled output
 * format are dropped and their weight redistributed, so a PDF-only job still reaches 100 rather
 * than stalling at the EPUB boundary.
 */
function buildBands(order: JobStageKey[], enabledFormats: JobOutputFormat[]): StageBand[] {
  const included = order.filter((key) => {
    const { format } = STAGES[key];
    return !format || enabledFormats.includes(format);
  });
  const totalWeight = included.reduce((sum, key) => sum + STAGES[key].weight, 0);
  const bands: StageBand[] = [];
  let cursor = 0;
  for (const key of included) {
    const { label, weight } = STAGES[key];
    const span = totalWeight > 0 ? (weight / totalWeight) * 100 : 0;
    bands.push({ key, label, start: cursor, end: cursor + span });
    cursor += span;
  }
  // Absorb floating-point drift so the final band ends exactly at 100.
  if (bands.length > 0) bands[bands.length - 1].end = 100;
  return bands;
}

export class JobProgressReporter implements ProgressReporter {
  private readonly jobID: string;
  private readonly enabledFormats: JobOutputFormat[];
  private readonly minWriteIntervalMs: number;
  private readonly logger: LogLayer;

  private bands: Map<JobStageKey, StageBand>;

  private current: StageBand;
  private expected = 0;
  private completed = 0;
  private stageStartedAt = Date.now();

  private readonly startedAt = Date.now();
  private lastValue = 0;
  private lastLabel: string | null = null;
  private lastWriteAt = 0;
  /**
   * The most recent value the throttle in `emit` turned away, held so `flush` can still write it.
   * Cleared on every real write. Null when nothing is outstanding.
   */
  private pending: { progress: number; stage: string } | null = null;
  private creepTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** Serializes writes so a slow UPDATE can't land after a newer one and move progress backwards. */
  private inFlight: Promise<void> = Promise.resolve();

  constructor(jobID: string, opts?: { enabledFormats?: JobOutputFormat[]; singlePage?: boolean }) {
    this.jobID = jobID;
    this.enabledFormats = opts?.enabledFormats ?? ['EPUB', 'PDF', 'ThinCC'];
    const order = opts?.singlePage ? SINGLE_PAGE_STAGE_ORDER : FULL_STAGE_ORDER;
    const bands = buildBands(order, this.enabledFormats);
    this.bands = new Map(bands.map((band) => [band.key, band]));
    this.current = bands[0];

    const parsed = Number.parseInt(
      Environment.getOptional('JOB_PROGRESS_MIN_WRITE_MS', String(DEFAULT_MIN_WRITE_INTERVAL_MS)),
      10,
    );
    this.minWriteIntervalMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_WRITE_INTERVAL_MS;

    this.logger = logService.child().withContext({ jobID, logSource: 'JobProgress' });
    this.startHeartbeat();
  }

  /**
   * Liveness ping, deliberately independent of whether the estimate moved.
   *
   * JobService presumes an 'inprogress' row whose `updatedAt` has stopped advancing belongs to a
   * dead worker and marks it failed, which frees the book for resubmission. Progress writes alone
   * cannot carry that signal: the creep curve in during() flattens long before a slow Prince run
   * finishes, and the archive-and-upload tails of the EPUB and Individual.zip stages report
   * nothing at all. A book that stayed quiet past the cutoff would be reaped mid-flight and a
   * second worker would start writing the same S3 keys. So liveness gets its own timer, and stays
   * a fact about the worker rather than a side effect of the number changing.
   */
  private startHeartbeat() {
    this.heartbeatTimer = setInterval(() => this.touch(), HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Re-writes the current values solely to move `updatedAt`. Skipped when a real write already
   * landed inside the interval, since that write was itself the heartbeat, and abandoned entirely
   * once the job passes MAX_HEARTBEAT_AGE_MS.
   */
  private touch() {
    const age = Date.now() - this.startedAt;
    if (age > MAX_HEARTBEAT_AGE_MS) {
      this.logger
        .withMetadata({ ageMs: age, budgetMs: JOB_MAX_DURATION_MS, stage: this.current.key })
        .warn(
          'Job outlived its budget plus the heartbeat grace period without failing itself; it is ' +
            'wedged short of a checkpoint. Releasing it to the staleness reaper.',
        );
      this.stopHeartbeat();
      return;
    }
    if (Date.now() - this.lastWriteAt < HEARTBEAT_INTERVAL_MS) return;
    // A value the throttle turned away is newer than lastValue, so spend the beat on it rather
    // than rewriting a stale number and leaving the fresh one waiting for the next one.
    if (this.pending) {
      this.write(this.pending.progress, this.pending.stage);
      return;
    }
    this.lastWriteAt = Date.now();
    this.enqueue(this.lastValue, this.lastLabel ?? this.current.label);
  }

  public elapsedMs() {
    return Date.now() - this.startedAt;
  }

  /**
   * Moves to a new stage. The previous stage's elapsed time is logged (the raw material for
   * recalibrating the weights above) and the new band's floor is written immediately, so a stage
   * change is always visible to a polling client even if no ticks follow.
   */
  public enter(stage: JobStageKey) {
    this.stopCreep();
    const band = this.bands.get(stage);
    if (!band) return; // stage belongs to a disabled format
    if (this.lastLabel !== null) {
      this.logger
        .withMetadata({ stage: this.current.key, durationMs: Date.now() - this.stageStartedAt })
        .debug('Job stage complete');
    }
    this.current = band;
    this.expected = 0;
    this.completed = 0;
    this.stageStartedAt = Date.now();
    this.emit(band.start, true);
  }

  /**
   * Re-plans onto the single-content-page pipeline, which skips most of the PDF stages. Called once
   * page discovery reveals the book is a lone page, since that isn't knowable when the reporter is
   * constructed. The monotonic floor carries over, so the reported value cannot jump backwards.
   */
  public useSinglePagePlan() {
    const bands = buildBands(SINGLE_PAGE_STAGE_ORDER, this.enabledFormats);
    this.bands = new Map(bands.map((band) => [band.key, band]));
    this.current = this.bands.get(this.current.key) ?? this.current;
  }

  /** Sets the denominator for subsequent tick() calls. */
  public expect(total: number) {
    this.expected = Math.max(0, total);
    this.completed = 0;
  }

  public tick(count = 1) {
    this.completed += count;
    if (this.expected > 0) this.report(this.completed / this.expected);
  }

  public fraction(done: number, total: number) {
    if (total > 0) this.report(done / total);
  }

  /**
   * Runs an operation that reports nothing from the inside (a single Prince invocation over every
   * HTML file, for instance) while advancing progress along 1 - e^(-t/estimate). The curve
   * asymptotes below the band ceiling, so a slow run keeps moving without ever overtaking the next
   * real checkpoint, and a stalled one stops producing writes once the curve flattens.
   */
  public async during<T>(stage: JobStageKey, estimateMs: number, fn: () => Promise<T>): Promise<T> {
    this.enter(stage);
    const startedAt = Date.now();
    const tau = Math.max(estimateMs, 1);
    this.creepTimer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      this.report((1 - Math.exp(-elapsed / tau)) * CREEP_BAND_CEILING);
    }, CREEP_TICK_MS);
    this.creepTimer.unref?.();
    try {
      return await fn();
    } finally {
      this.stopCreep();
    }
  }

  /** Forces any throttled value to disk and waits for every queued write to settle. */
  public async flush() {
    if (this.pending) this.write(this.pending.progress, this.pending.stage);
    await this.inFlight;
  }

  public stop() {
    this.stopCreep();
    this.stopHeartbeat();
  }

  private stopCreep() {
    if (this.creepTimer) {
      clearInterval(this.creepTimer);
      this.creepTimer = null;
    }
  }

  /** Maps a 0-1 completion fraction within the current stage onto the overall scale. */
  private report(f: number) {
    const band = this.current;
    this.emit(band.start + clamp(f, 0, 1) * (band.end - band.start));
  }

  private emit(value: number, force = false) {
    const next = clamp(Math.round(value), this.lastValue, MAX_INPROGRESS_PROGRESS);
    const changed = next !== this.lastValue || this.current.label !== this.lastLabel;
    if (!changed) return;
    if (!force && Date.now() - this.lastWriteAt < this.minWriteIntervalMs) {
      // Throttled, not discarded. Without this the last value of a stage is lost whenever the stage
      // ends inside the throttle window, and flush() has nothing left to write.
      this.pending = { progress: next, stage: this.current.label };
      return;
    }
    this.write(next, this.current.label);
  }

  private write(progress: number, stage: string) {
    this.lastValue = progress;
    this.lastLabel = stage;
    this.lastWriteAt = Date.now();
    this.pending = null;
    this.enqueue(progress, stage);
  }

  /**
   * Appends a row write to the serialized chain. The values may be unchanged (a heartbeat), which
   * still rewrites `updatedAt` and is the whole point of that path.
   */
  private enqueue(progress: number, stage: string) {
    this.inFlight = this.inFlight
      .then(async () => {
        await Job.update({ progress, stage }, { where: { id: this.jobID } });
      })
      .catch((error) => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.withMetadata({ error: errorMsg, progress, stage }).warn('Failed to persist job progress');
      });
  }
}

/**
 * Stand-in for callers that have no job to report against (the single-page helpers used from
 * tests, or a service constructed outside a job). Keeps every call site free of null checks.
 */
export const nullProgressReporter: ProgressReporter = {
  // No job, so no job deadline. Standalone callers fall back to their own local clock.
  elapsedMs: () => 0,
  enter: () => undefined,
  expect: () => undefined,
  tick: () => undefined,
  fraction: () => undefined,
  during: <T>(_stage: JobStageKey, _estimateMs: number, fn: () => Promise<T>) => fn(),
  flush: async () => undefined,
  stop: () => undefined,
};
