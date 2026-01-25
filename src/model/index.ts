import { Sequelize } from 'sequelize-typescript';
import { Job } from './job';
import { getEnvironment, getEnvironmentVariable } from '../lib/environment';
import { ConnectionOptions } from 'sequelize';

const env = getEnvironment();
function getReaderConfig(): ConnectionOptions | null {
  const host = getEnvironmentVariable(`${env}_DB_HOST_READ`, 'NONE');
  if (host !== 'NONE') {
    const username = getEnvironmentVariable(`${env}_DB_USER_READ`, '');
    const password = getEnvironmentVariable(`${env}_DB_PASSWORD_READ`, '');
    const port = getEnvironmentVariable(`${env}_DB_PORT_READ`, 3306);
    if (username && password && port) return { host, password, port, username };
  }
  return null;
}

const readerConfig = getReaderConfig();
const writerConfig = {
  host: getEnvironmentVariable(`${env}_DB_HOST`, 'localhost'),
  password: getEnvironmentVariable(`${env}_DB_PASSWORD`, 'shapeshift_db_password'),
  port: Number(getEnvironmentVariable(`${env}_DB_PORT`, 3306)),
  username: getEnvironmentVariable(`${env}_DB_USER`, 'shapeshift_db_username'),
};
const sequelize = new Sequelize({
  dialect: 'mysql',
  database: getEnvironmentVariable(`${env}_DB`, 'shapeshift'),
  logging: env === 'DEVELOPMENT' ? console.log : false,
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
