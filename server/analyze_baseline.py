import json
import os

state_path = r'e:\antigravity\homepage\orbitalpha-trading\server\data\orbitalpha-trading\paper\orbitalpha\trading\paper_state.json'

with open(state_path, 'r', encoding='utf-8') as f:
    state = json.load(f)

history = state.get('history', [])
closed = [h for h in history if h['state'] in ['CLOSED_WIN', 'CLOSED_LOSS', 'CLOSED_TIMEOUT']]

total_trades = len(closed)
wins = len([h for h in closed if h['state'] == 'CLOSED_WIN'])
losses = len([h for h in closed if h['state'] == 'CLOSED_LOSS'])
win_rate = (wins / total_trades * 100) if total_trades > 0 else 0

total_pnl = sum([h.get('pnl_krw', 0) for h in closed if h.get('pnl_krw') is not None])
avg_pnl = (total_pnl / total_trades) if total_trades > 0 else 0

exit_reasons = {}
for h in closed:
    reason = h.get('note', 'unknown')
    exit_reasons[reason] = exit_reasons.get(reason, 0) + 1

print(f"Total Closed: {total_trades}")
print(f"Wins: {wins}, Losses: {losses}")
print(f"Win Rate: {win_rate:.1f}%")
print(f"Avg PnL: {avg_pnl:,.0f} KRW")
print(f"Exit Reasons: {json.dumps(exit_reasons, indent=1)}")
