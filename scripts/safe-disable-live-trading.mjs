import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

console.log(`[safe-disable] Starting emergency safe shutdown script...`);
console.log(`[safe-disable] Resolved repository root: ${root}`);

// 백업 유틸리티 함수
const backupFile = (filePath) => {
  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.bak`;
    fs.copyFileSync(filePath, backupPath);
    console.log(`[safe-disable] Backed up ${path.basename(filePath)} to ${path.basename(backupPath)}`);
  }
};

// 1. .env 및 .env.local 수정
const envFiles = ['.env', '.env.local'];
for (const file of envFiles) {
  const envPath = path.join(root, file);
  if (fs.existsSync(envPath)) {
    // 수정 전에 백업 생성
    backupFile(envPath);

    let content = fs.readFileSync(envPath, 'utf8');
    const key = 'ORBITALPHA_TRADING_LIVE_ORDER_CONFIRM';
    
    // 안전한 라인별 처리로 중복이나 주석 여부 상관없이 덮어씀
    let lines = content.split(/\r?\n/);
    let found = false;
    lines = lines.map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}=`) || trimmed.startsWith(`#${key}=`) || trimmed.startsWith(`# ${key}=`)) {
        found = true;
        return `${key}=false`;
      }
      return line;
    });
    if (!found) {
      lines.push(`${key}=false`);
    }
    content = lines.join('\n');
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
// 수정 전에 백업 생성
backupFile(statePath);

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
  const pm2Commands = [
    'pm2 restart ecosystem.trading.config.cjs --update-env',
    'pm2 restart all --update-env',
    'npx pm2 restart ecosystem.trading.config.cjs --update-env',
    'npx pm2 restart all --update-env'
  ];

  let success = false;
  for (const cmd of pm2Commands) {
    try {
      console.log(`[safe-disable] Running command: ${cmd}`);
      execSync(cmd, { stdio: 'inherit', cwd: root });
      console.log(`[safe-disable] PM2 app restart succeeded using: ${cmd}`);
      success = true;
      break;
    } catch (err) {
      console.warn(`[safe-disable] Command failed: ${cmd}. Trying next option...`);
    }
  }

  if (!success) {
    throw new Error('All PM2 restart commands failed.');
  }
} catch (e) {
  console.error(`[safe-disable] PM2 command execution failed entirely. Please execute manually: 'pm2 restart ecosystem.trading.config.cjs --update-env' or 'pm2 restart all --update-env'. Error:`, e.message);
}
