import { createMemoryServer } from './server.js';

const PORT = parseInt(process.env.PORT ?? '3800', 10);

const server = createMemoryServer();

server.listen(PORT, () => {
  console.log(`walle-memory-server listening on :${PORT}`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
