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
import { Optional } from 'sequelize';

interface ApiCredentialAttributes {
  active: boolean;
  clientName: string;
  createdAt: Date;
  id: string;
  keyHash: string;
  updatedAt?: Date;
}

interface ApiCredentialCreationAttributes extends Optional<ApiCredentialAttributes, 'createdAt' | 'id' | 'updatedAt'> {}

@Table({
  timestamps: true,
  tableName: 'api_credentials',
})
export class ApiCredential extends Model<ApiCredentialAttributes, ApiCredentialCreationAttributes> {
  @PrimaryKey
  @AllowNull(false)
  @Default(DataType.UUIDV4)
  @Column(DataType.STRING)
  declare id: string;

  @AllowNull(false)
  @Column(DataType.STRING)
  declare clientName: string;

  @AllowNull(false)
  @Column(DataType.STRING)
  declare keyHash: string;

  @AllowNull(false)
  @Default(true)
  @Column(DataType.BOOLEAN)
  declare active: boolean;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
