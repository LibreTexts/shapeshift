import { LogLayer, ConsoleTransport } from 'loglayer';
import { Environment } from './environment';

export const log = new LogLayer({
  contextFieldName: 'context',
  metadataFieldName: 'metadata',
  transport: new ConsoleTransport({
    logger: console,
    messageField: 'msg',
    stringify: Environment.getSystemEnvironment() !== 'DEVELOPMENT',
  }),
});
