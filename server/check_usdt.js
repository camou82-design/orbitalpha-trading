import fetch from 'node:fetch';

async function checkUsdt() {
    const url = 'https://api.upbit.com/v1/ticker?markets=KRW-USDT';
    try {
        const r = await fetch(url);
        const j = await r.json();
        print(JSON.stringify(j, null, 2));
    } catch (e) {
        print("Error: " + e.message);
    }
}

// In this environment, I can't easily use print in a script unless I use console.log or similar.
// I'll just use a small node script and run it.
