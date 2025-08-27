import { serializeError } from 'serialize-error';
import { LogLayer, ConsoleTransport } from 'loglayer';

export const log = new LogLayer({
  contextFieldName: 'context',
  metadataFieldName: 'metadata',
  errorSerializer: serializeError,
  transport: new ConsoleTransport({
    logger: console,
    messageField: 'msg',
  }),
});
