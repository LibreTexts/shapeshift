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
  id: string;
  isHighPriority: boolean;
  requesterIp: string;
  status: JobStatus;
  updatedAt?: Date;
  url: string;
}

interface JobCreationAttributes extends Optional<JobAttributes, 'createdAt' | 'id' | 'status' | 'updatedAt'> {}

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

  @Column(DataType.BOOLEAN)
  declare isHighPriority: boolean;

  @Column(DataType.STRING)
  declare requesterIp: string;

  @Column(DataType.STRING)
  declare url: string;

  @Index({ order: 'DESC' })
  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
