import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = 'e:/2026.06.28/antigravity/homepage/orbitalpha-trading';

console.log(`[safe-disable] Starting emergency safe shutdown script...`);

// 1. .env 및 .env.local 수정
const envFiles = ['.env', '.env.local'];
for (const file of envFiles) {
  const envPath = path.join(root, file);
  if (fs.existsSync(envPath)) {
    let content = fs.readFileSync(envPath, 'utf8');
    const key = 'ORBITALPHA_TRADING_LIVE_ORDER_CONFIRM';
    const regex = new RegExp(`^#?\\s*${key}\\s*=.*$`, 'm');
    
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=false`);
    } else {
      content += `\n${key}=false\n`;
    }
    fs.writeFileSync(envPath, content, 'utf8');
    console.log(`[safe-disable] Updated ${file} with ORBITALPHA_TRADING_LIVE_ORDER_CONFIRM=false`);
  } else {
    // 만약 파일이 아예 없다면 .env.local을 생성
    if (file === '.env.local') {
      fs.writeFileSync(envPath, 'ORBITALPHA_TRADING_LIVE_ORDER_CONFIRM=false\n', 'utf8');
      console.log(`[safe-disable] Created new ${file} with ORBITALPHA_TRADING_LIVE_ORDER_CONFIRM=false`);
    }
  }
}

// 2. data/runtime/trade-control-state.json 수정
const statePath = path.join(root, 'data', 'runtime', 'trade-control-state.json');
let state = {
  autoTradeEnabled: false,
  autoTradeChangedAt: new Date().toISOString(),
  strategyPositions: {},
  legacyBuckets: {}
};

if (fs.existsSync(statePath)) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    state = {
      ...parsed,
      autoTradeEnabled: false,
      autoTradeChangedAt: new Date().toISOString()
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    console.log(`[safe-disable] Updated existing trade-control-state.json with autoTradeEnabled=false`);
  } catch (e) {
    console.error(`[safe-disable] Failed to parse existing trade-control-state.json, overwriting...`, e);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  }
} else {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    console.log(`[safe-disable] Created new trade-control-state.json with autoTradeEnabled=false`);
  } catch (e) {
    console.error(`[safe-disable] Failed to create trade-control-state.json:`, e);
  }
}

// 3. PM2 restart 실행
try {
  console.log(`[safe-disable] Restarting PM2 apps with --update-env...`);
  try {
    execSync('pm2 restart ecosystem.trading.config.cjs --update-env', { stdio: 'inherit', cwd: root });
    console.log(`[safe-disable] PM2 apps restarted via global pm2.`);
  } catch (err) {
    console.warn(`[safe-disable] Global PM2 execution failed. Attempting via npx...`);
    execSync('npx pm2 restart ecosystem.trading.config.cjs --update-env', { stdio: 'inherit', cwd: root });
    console.log(`[safe-disable] PM2 apps restarted via npx pm2.`);
  }
} catch (e) {
  console.error(`[safe-disable] PM2 command execution failed entirely. Please execute manually: 'pm2 restart ecosystem.trading.config.cjs --update-env'. Error:`, e.message);
}
