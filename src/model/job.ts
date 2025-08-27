import {
  AllowNull,
  Column,
  CreatedAt,
  DataType,
  Default,
  Model,
  PrimaryKey,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { JobStatus } from '../services/job';
import { Optional } from 'sequelize';

interface JobAttributes {
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
})
export class Job extends Model<JobAttributes, JobCreationAttributes> {
  @PrimaryKey
  @AllowNull(false)
  @Default(DataType.UUIDV4)
  @Column(DataType.STRING)
  declare id: string;

  @Column(DataType.ENUM('created', 'inprogress', 'finished', 'failed'))
  declare status: JobStatus;

  @Column(DataType.BOOLEAN)
  declare isHighPriority: boolean;

  @Column(DataType.STRING)
  declare requesterIp: string;

  @Column(DataType.STRING)
  declare url: string;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
