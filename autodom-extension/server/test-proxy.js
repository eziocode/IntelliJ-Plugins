import cp from 'child_process';
import { WebSocket } from 'ws';

// 1. Start Primary Server
const p1 = cp.spawn('node', ['./index.js'], { stdio: ['ignore', 'pipe', 'pipe'] });

// Wait 1s, connect extension to Primary
setTimeout(() => {
    const extension = new WebSocket('ws://127.0.0.1:9876');
    extension.on('open', () => {
        console.log('[Ext] Connected');
        extension.send(JSON.stringify({ type: 'KEEPALIVE' }));
    });
    extension.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'TOOL_CALL') {
            console.log('[Ext] Got tool call:', msg.tool);
            extension.send(JSON.stringify({ type: 'TOOL_RESULT', id: msg.id, result: { proxied: true } }));
        }
    });

    // 2. Start Secondary (Proxy) Server
    setTimeout(() => {
        console.log('Starting secondary server...');
        const p2 = cp.spawn('node', ['./index.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
        let stderrStr = "";
        p2.stderr.on('data', d => {
            console.log('[P2 STDERR]', d.toString().trim());
            stderrStr += d.toString();
        });
        p2.stdout.on('data', d => {
            console.log('[P2 STDOUT]', d.toString().trim());
        });

        p2.on('close', code => {
            console.log('P2 closed with code', code);
        });

        // Call tool via stdio on P2
        setTimeout(() => {
            console.log('Initializing P2 MCP...');
            p2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ide2', version: '1' } } }) + '\n');
            setTimeout(() => {
                console.log('Calling tool on P2...');
                p2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_tabs', arguments: {} } }) + '\n');
            }, 500);
        }, 1000);

        setTimeout(() => { p1.kill(); p2.kill(); process.exit(); }, 4000);
    }, 1000);
}, 1000);
