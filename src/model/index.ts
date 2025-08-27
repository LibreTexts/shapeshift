import { Sequelize } from 'sequelize-typescript';
import { Job } from './job';
import { getEnvironment, getEnvironmentVariable } from '../lib/environment';

const env = getEnvironment();
const sequelize = new Sequelize(
  getEnvironmentVariable(`${env}_DB`, 'shapeshift'),
  getEnvironmentVariable(`${env}_DB_USER`, 'shapeshift_db_username'),
  getEnvironmentVariable(`${env}_DB_PASSWORD`, 'shapeshift_db_password'),
  {
    dialect: 'mysql',
    host: getEnvironmentVariable(`${env}_DB_HOST`, 'localhost'),
    logging: env === 'DEVELOPMENT' ? console.log : false,
    port: Number(getEnvironmentVariable(`${env}_DB_PORT`, 3306)),
  },
);

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
