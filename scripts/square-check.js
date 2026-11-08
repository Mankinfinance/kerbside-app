// Read-only check that the Square keys work: lists locations and counts menu items.
// Usage: GATEWAY=square SQUARE_ACCESS_TOKEN=... SQUARE_APPLICATION_ID=... npm run square:check
import { config } from '../src/config.js';
import { createSquareHttpGateway } from '../src/square/http-gateway.js';

if (config.gateway !== 'square') { console.error('Set GATEWAY=square to check the real Square connection.'); process.exit(1); }
const g = createSquareHttpGateway(config.square);
const locations = await g.listLocations();
console.log(`Square ${config.square.environment}: ${locations.length} active location(s)`);
for (const l of locations) console.log(` - ${l.id}  ${l.name}  ${l.address}`);
const menu = await g.listMenu();
console.log(`Menu: ${menu.length} item(s) with fixed prices`);
