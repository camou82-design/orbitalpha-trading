import json
import glob
from datetime import datetime, timedelta

def parse_logs(file_pattern):
    events = []
    for f_path in glob.glob(file_pattern):
        with open(f_path, 'r', encoding='utf8') as f:
            for line in f:
                try:
                    events.append(json.loads(line))
                except: continue
    return events

# 1. Get all events
events = parse_logs(r'e:\antigravity\homepage\orbitalpha-trading\server\data\orbitalpha-trading\logs\events_*.jsonl')
snapshots = parse_logs(r'e:\antigravity\homepage\orbitalpha-trading\server\data\orbitalpha-trading\logs\snapshots_*.jsonl')

trades = []
current_entries = {}

for e in events:
    m = e.get('market')
    ts = e.get('timestamp') or e.get('ts')
    if not m or not ts: continue
    
    # Entry
    if e.get('event_type') == 'paper_entry' or e.get('tag') == 'PAPER_ENTRY_SUBMITTED':
        current_entries[m] = e
    # Exit
    elif e.get('event_type') == 'paper_exit' or (e.get('kind') == 'opLog' and e.get('type') == 'sell'):
        if m in current_entries:
            entry = current_entries.pop(m)
            pnl = e.get('pnl_net_pct') or e.get('pnl_pct') or 0
            trades.append({'market': m, 'pnl': pnl, 'entry': entry, 'exit': e})

trades.sort(key=lambda x: (x['exit'].get('timestamp') or x['exit'].get('ts')), reverse=True)

# Top 10 failures or small gains (pnl < 0.7)
failures = [t for t in trades if t['pnl'] < 0.8][:10]

results = []
for f in failures:
    m = f['market']
    e_ts = f['entry'].get('timestamp') or f['entry'].get('ts')
    e_dt = datetime.fromisoformat(e_ts.replace('Z', '+00:00'))
    e_p = f['entry'].get('avg_buy_price') or f['entry'].get('price')
    e_v = f['entry'].get('volume_1m') or 0
    
    # Granular data for 5 mins
    m_snaps = [s for s in snapshots if s.get('market') == m]
    m_snaps.sort(key=lambda x: x.get('timestamp') or x.get('ts'))
    
    trace = []
    max_p = e_p
    for s in m_snaps:
        s_ts = s.get('timestamp') or s.get('ts')
        s_dt = datetime.fromisoformat(s_ts.replace('Z', '+00:00'))
        if e_dt <= s_dt <= e_dt + timedelta(minutes=5):
            p = s.get('current_price') or s.get('price') or e_p
            v = s.get('volume_1m') or 0
            max_p = max(max_p, p)
            trace.append({'ts': s_ts, 'p': p, 'v': v})
    
    results.append({
        'market': m,
        'pnl': f['pnl'],
        'max_up': round(((max_p - e_p) / e_p) * 100, 2) if e_p else 0,
        'entry_v': e_v,
        'trace': trace[:5]
    })

print(json.dumps(results, indent=2))
