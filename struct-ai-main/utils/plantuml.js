const zlib = require('zlib');
const axios = require('axios');

const PU_ALPHA =
  '0123456789' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  'abcdefghijklmnopqrstuvwxyz' +
  '-_';
const B64_ALPHA =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ' +
  'abcdefghijklmnopqrstuvwxyz' +
  '0123456789' +
  '+/';

const SERVERS = [
  'http://www.plantuml.com/plantuml/img/',
  'https://www.plantuml.com/plantuml/img/',
  'http://www.plantuml.com/plantuml/png/',
];

/**
 * PlantUML's "deflate" text encoding: raw zlib-deflate the UTF-8 text,
 * base64-encode it, then map the standard base64 alphabet onto PlantUML's
 * own URL-safe alphabet. This mirrors the Python implementation exactly
 * (zlib.compress(...)[2:-4] strips the zlib header/trailer to get a raw
 * deflate stream, equivalent to using a raw deflate transform here).
 */
function encode(text) {
  const deflated = zlib.deflateRawSync(Buffer.from(text, 'utf-8'), { level: 9 });
  const b64 = deflated.toString('base64');
  let out = '';
  for (const ch of b64) {
    const idx = B64_ALPHA.indexOf(ch);
    out += idx === -1 ? '' : PU_ALPHA[idx];
  }
  return out;
}

const isPng = (buf) => buf.length > 8 && buf.slice(0, 4).toString('hex') === '89504e47';

async function renderDiagram(syntax) {
  const trimmed = syntax.trim();
  const full = trimmed.startsWith('@start') ? trimmed : `@startuml\n${trimmed}\n@enduml`;
  const encoded = encode(full);

  // 1) Your own PlantUML server first, if configured (most reliable):
  //    PLANTUML_SERVER=https://your-plantuml.example.com/plantuml
  const servers = [];
  if (process.env.PLANTUML_SERVER) {
    servers.push(process.env.PLANTUML_SERVER.replace(/\/+$/, '') + '/png/');
  }
  servers.push(...SERVERS);

  let lastError = 'No server tried';
  for (const server of servers) {
    try {
      const resp = await axios.get(server + encoded, {
        responseType: 'arraybuffer',
        timeout: 20000,
        validateStatus: () => true,
      });
      const buf = Buffer.from(resp.data);
      if (resp.status === 200 && isPng(buf)) return buf;
      lastError = `HTTP ${resp.status} from ${server}`;
    } catch (err) {
      lastError = err.code === 'ECONNABORTED' ? `Timeout on ${server}` : `Connection error: ${err.message}`;
    }
  }

  // 2) Independent fallback: Kroki renders PlantUML too (POST plain text).
  try {
    const resp = await axios.post('https://kroki.io/plantuml/png', full, {
      headers: { 'Content-Type': 'text/plain' },
      responseType: 'arraybuffer',
      timeout: 25000,
      validateStatus: () => true,
    });
    const buf = Buffer.from(resp.data);
    if (resp.status === 200 && isPng(buf)) return buf;
    lastError = `HTTP ${resp.status} from kroki.io`;
  } catch (err) {
    lastError = `kroki.io: ${err.message}`;
  }

  console.error('[plantuml] all renderers failed:', lastError);
  throw new Error('Diagram rendering is temporarily unavailable. Please try again in a minute.');
}

module.exports = { renderDiagram, encode };
