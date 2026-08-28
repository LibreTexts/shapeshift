import {
  AllowNull,
  Column,
  CreatedAt,
  DataType,
  Default,
  Index,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { type JobStatus } from '../services/job';
import { Optional } from 'sequelize';

interface JobAttributes {
  bookID?: string;
  createdAt: Date;
  failureReason?: string | null;
  id: string;
  isHighPriority: boolean;
  progress: number;
  requesterIp: string;
  stage: string | null;
  status: JobStatus;
  updatedAt?: Date;
  url: string;
}

interface JobCreationAttributes
 
  extends Optional<JobAttributes, 'createdAt' | 'failureReason' | 'id' | 'progress' | 'stage' | 'status' | 'updatedAt'> {}

@Table({
  timestamps: true,
  tableName: 'jobs',
  indexes: [
    // Supports the duplicate-submission lookup in JobService.findActiveByBookID(), which filters
    // on bookID + status before every job is queued.
    { name: 'jobs_book_id_status', fields: ['bookID', 'status'] },
  ],
})
export class Job extends Model<JobAttributes, JobCreationAttributes> {
  @PrimaryKey
  @AllowNull(false)
  @Default(DataType.UUIDV4)
  @Column(DataType.STRING)
  declare id: string;

  @Index
  @Column(DataType.ENUM('created', 'inprogress', 'finished', 'failed'))
  declare status: JobStatus;

  @Column(DataType.STRING)
  declare bookID: string;

  /**
   * Coarse completion estimate for the job, 0-100. Written by the processor at throttled
   * checkpoints (see lib/jobProgress.ts) and read back by GET /job/:jobID. Deliberately
   * conservative: it is capped at 99 until the job reaches 'finished'.
   */
  @AllowNull(false)
  @Default(0)
  @Column(DataType.TINYINT.UNSIGNED)
  declare progress: number;

  /** Human-readable label for the pipeline stage `progress` was last measured in. */
  @AllowNull(true)
  @Column(DataType.STRING(64))
  declare stage: string | null;

  @Column(DataType.BOOLEAN)
  declare isHighPriority: boolean;

  @Column(DataType.STRING)
  declare requesterIp: string;

  @Column(DataType.STRING)
  declare url: string;

  /**
   * Why a failed job failed, in the operator's words rather than a stack trace. A book that fails
   * conversion almost always needs a content fix upstream before it is worth resubmitting, and
   * without this the only record of what to fix is a log line on whichever worker happened to run
   * it. TEXT rather than STRING because the reason names the offending pages.
   */
  @Column(DataType.TEXT)
  declare failureReason: string | null;

  @Index({ order: 'DESC' })
  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
