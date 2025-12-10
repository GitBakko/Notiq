import { spawn } from 'child_process';
import path from 'path';
import WebSocket from 'ws';

console.log('Starting server...');
const server = spawn('npm', ['run', 'dev'], {
  cwd: path.join(__dirname),
  shell: true,
  stdio: 'pipe'
});

let testRunning = false;

server.stdout.on('data', (data) => {
  const output = data.toString();
  console.log(`Server: ${output.trim()}`);
  if (output.includes('Hocuspocus attached to /ws') && !testRunning) {
    testRunning = true;
    console.log('Server ready detected, waiting 2s before connecting...');
    setTimeout(runTest, 2000);
  }
});

server.stderr.on('data', (data) => {
  console.error(`Server Error: ${data.toString().trim()}`);
});

function runTest() {
  console.log('Attempting WebSocket connection...');
  const ws = new WebSocket('ws://localhost:3001/ws');

  ws.on('open', () => {
    console.log('SUCCESS: Connected to WebSocket on port 3001/ws');
    ws.close();
    cleanup(0);
  });

  ws.on('error', (err) => {
    console.error('FAILURE: WebSocket error:', err);
    cleanup(1);
  });
}

function cleanup(code = 0) {
  console.log('Cleaning up...');
  spawn('taskkill', ['/pid', server.pid?.toString() || '', '/f', '/t']);
  process.exit(code);
}

setTimeout(() => {
    console.log('Timeout reached, killing server');
    cleanup(1);
}, 20000);
