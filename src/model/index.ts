import { Sequelize } from 'sequelize-typescript';
import { Job } from './job';
import { Environment } from '../lib/environment';
import { ConnectionOptions } from 'sequelize';

function getReaderConfig(): ConnectionOptions | null {
  const host = Environment.getOptional('DB_HOST_READ', 'NONE');
  if (host !== 'NONE') {
    const username = Environment.getOptional('DB_USER_READ');
    const password = Environment.getOptional('DB_PASSWORD_READ');
    const port = Number.parseInt(Environment.getOptional('DB_PORT_READ', '3306'));
    if (username && password && port) return { host, password, port, username };
  }
  return null;
}

const readerConfig = getReaderConfig();
const writerConfig = {
  host: Environment.getOptional('DB_HOST', 'localhost'),
  password: Environment.getOptional('DB_PASSWORD'),
  port: Number.parseInt(Environment.getOptional('DB_PORT', '3306')),
  username: Environment.getOptional('DB_USER'),
};
const sequelize = new Sequelize({
  dialect: 'mysql',
  database: Environment.getOptional('DB', 'shapeshift'),
  logging: Environment.getSystemEnvironment() === 'DEVELOPMENT' ? console.log : false,
  ...(readerConfig
    ? {
        replication: {
          read: [readerConfig],
          write: writerConfig,
        },
      }
    : writerConfig),
});

sequelize.addModels([Job]);

/**
 * Attempts to establish a connection to the database.
 *
 * @returns True if connection established, false if failed.
 */
export async function connectDatabase(sync: boolean = false): Promise<boolean> {
  try {
    await sequelize.sync({ alter: sync });
    console.log('[DB] Established database connection.');
  } catch (e) {
    console.error('[DB] Error establishing connection:', e);
    return false;
  }
  return true;
}

export { sequelize, Job };
