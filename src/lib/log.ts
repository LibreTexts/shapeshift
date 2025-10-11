import { LogLayer, ConsoleTransport } from 'loglayer';

export const log = new LogLayer({
  contextFieldName: 'context',
  metadataFieldName: 'metadata',
  transport: new ConsoleTransport({
    logger: console,
    messageField: 'msg',
  }),
});
