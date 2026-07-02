import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = 'e:/2026.06.28/antigravity/homepage/orbitalpha-trading';

// 검색할 키워드들
const keywords = [
  'KRW-BTC',
  'BTC',
  'manual_buy_response',
  'manual_sell_response',
  'order_filled',
  'reason_exit',
  'RECOVERED_AFTER_LEDGER_MISS',
  'MANAGED_POSITION_RECOVERY_HARD_WARNING',
  'SPOT_MANAGED_POSITION_RECOVERY_APPLIED_PROOF',
  'placeSell'
];

const events = [];

// 1. data 폴더의 jsonl 파일들 탐색
const logsDir = path.join(root, 'data/orbitalpha-trading/logs');
console.log(`[diagnose-btc] Searching logs in: ${logsDir}`);

function scanDir(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      scanDir(fullPath);
    } else if (file.endsWith('.jsonl')) {
      searchJsonlFile(fullPath);
    }
  }
}

function searchJsonlFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const strEntry = JSON.stringify(entry);
      
      // 키워드 매칭 검사
      const matches = keywords.some(kw => strEntry.includes(kw));
      if (matches) {
        const ts = entry.ts || entry.timestamp || new Date().toISOString();
        const market = entry.market || (entry.payload && entry.payload.market) || '';
        const side = entry.side || (entry.payload && entry.payload.side) || '';
        const reason = entry.reason || entry.message || (entry.payload && entry.payload.reason) || '';
        const pnl = entry.pnl_net || entry.pnl_krw || (entry.payload && entry.payload.pnl_krw) || '';
        const order_uuid = entry.note || (entry.payload && entry.payload.order && entry.payload.order.uuid) || (entry.payload && entry.payload.note) || '';
        
        events.push({
          timestamp: ts,
          source_file: path.relative(root, filePath),
          event_type_message: entry.message || entry.event_type || 'jsonl_log',
          market,
          side,
          reason,
          pnl,
          order_uuid
        });
      }
    } catch {
      const matches = keywords.some(kw => line.includes(kw));
      if (matches) {
        events.push({
          timestamp: 'unknown',
          source_file: path.relative(root, filePath),
          event_type_message: line.trim(),
          market: '',
          side: '',
          reason: '',
          pnl: '',
          order_uuid: ''
        });
      }
    }
  }
}

scanDir(logsDir);

// 2. PM2 logs 탐색
const pm2Home = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
const pm2LogsDir = path.join(pm2Home, 'logs');
console.log(`[diagnose-btc] Searching PM2 logs in: ${pm2LogsDir}`);

if (fs.existsSync(pm2LogsDir)) {
  const pm2Files = fs.readdirSync(pm2LogsDir);
  for (const file of pm2Files) {
    if (file.includes('orbitalpha-trading-api') && file.endsWith('.log')) {
      const filePath = path.join(pm2LogsDir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const matches = keywords.some(kw => line.includes(kw));
        if (matches) {
          let ts = 'unknown';
          const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
          if (tsMatch) {
            ts = tsMatch[1];
          }
          
          events.push({
            timestamp: ts,
            source_file: `pm2:${file}`,
            event_type_message: line.trim(),
            market: line.includes('KRW-BTC') ? 'KRW-BTC' : '',
            side: line.includes('buy') ? 'buy' : (line.includes('sell') ? 'sell' : ''),
            reason: '',
            pnl: '',
            order_uuid: ''
          });
        }
      }
    }
  }
}

// 3. 시간순 정렬 및 출력
events.sort((a, b) => {
  if (a.timestamp === 'unknown') return 1;
  if (b.timestamp === 'unknown') return -1;
  return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
});

console.log('\n=== DIAGNOSIS RESULTS (CHRONOLOGICAL ORDER) ===');
console.log('timestamp, source_file, event_type_message, market, side, reason, pnl, order_uuid');
for (const ev of events) {
  console.log(`${ev.timestamp}, ${ev.source_file}, "${ev.event_type_message.replace(/"/g, '""')}", ${ev.market}, ${ev.side}, "${ev.reason}", ${ev.pnl}, ${ev.order_uuid}`);
}
