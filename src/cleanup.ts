// Delete every sandbox this demo created (display names start with "ab-").
import { connect, destroy, log } from './sbx.js';

const client = await connect();
try {
  const mine = [];
  for await (const s of client.allSandboxes({ query: { pageSize: 100 } })) {
    if (s.displayName?.startsWith('ab-')) mine.push(s);
  }
  await Promise.all(mine.map(async (s) => { log('cleanup', `deleting ${s.displayName} (${s.name})`); await destroy(await client.get(s.name)); }));
  log('cleanup', `done, ${mine.length} sandboxes removed`);
} finally {
  await client.close();
}
