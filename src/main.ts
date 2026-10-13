import { createApp } from './bootstrap';
import { runtimeConfig } from './common/configurations/runtime.config';
async function main() { const app = await createApp(); await app.listen(runtimeConfig().port, process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'); }
void main().catch(() => { console.error('API bootstrap failed; check non-secret configuration.'); process.exitCode = 1; });
