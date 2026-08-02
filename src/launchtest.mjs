import { Bridge } from './bridge.mjs';

const vm = process.argv[2] || 'Windows-7-7601';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForState(b, targetState, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = await b.call('info', { name: vm });
    if (info.stateName === targetState) return info;
    await sleep(2000);
  }
  throw new Error(`timeout waiting for state ${targetState}`);
}

const b = new Bridge();
await b.connect();
console.log('connected');

const before = await b.call('info', { name: vm });
console.log('before:', before.stateName);

if (before.stateName !== 'PoweredOff') {
  console.log('locking session...');
  await b.call('select', { name: vm });
  console.log('sending ACPI power-off...');
  await b.call('stop');
  await waitForState(b, 'PoweredOff', 90000);
  console.log('VM is powered off');
}

console.log('testing auto-start (LaunchVMProcess)...');
try {
  const res = await b.call('start', { name: vm });
  console.log('start op result:', JSON.stringify(res));
} catch (err) {
  console.log('START FAILED:', err.message);
  process.exit(1);
}

const started = await waitForState(b, 'Running', 90000);
console.log('VM is running:', started.stateName, `(real: ${started.realName})`);
await b.close();
console.log('DONE');
