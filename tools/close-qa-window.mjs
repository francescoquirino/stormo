import { connect } from './cdp.mjs';
const c = await connect(Number(process.argv[2]));
await c.evaluate('setTimeout(() => window.fm.win.close(), 100); "close scheduled"');
c.close();
