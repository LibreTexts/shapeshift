import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

// Enables the `.openapi()` metadata method on every Zod schema. `extendZodWithOpenApi` attaches the
// method at schema-construction time (not retroactively), so this MUST run before any schema is
// built — including the request validators in ./validators. It therefore lives in its own module
// that is imported first wherever Zod schemas are defined. Calling it more than once is a no-op.
extendZodWithOpenApi(z);

export { z };
