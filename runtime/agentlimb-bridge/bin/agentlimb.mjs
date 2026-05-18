#!/usr/bin/env node

const command = process.argv[2] || 'help';

if (command === 'bridge' || command === 'serve' || command === 'server') {
  await import('../kernel/bridge/mvp/run-server.js');
} else if (command === 'help' || command === '--help' || command === '-h') {
  printHelp();
} else {
  await import('../kernel/bridge/mvp/terminal-client.mjs');
}

function printHelp() {
  console.log([
    'AgentLimb local bridge',
    '',
    'Server:',
    '  agentlimb bridge',
    '',
    'Terminal client:',
    '  agentlimb start',
    '  agentlimb status',
    '  agentlimb call --tool tabs_context --params "{}"',
    '  agentlimb complete --task-id task_xxx --ok true --output "done"',
    '',
    'Direct scripts:',
    '  node kernel/bridge/mvp/run-server.js',
    '  node kernel/bridge/mvp/terminal-client.mjs status',
  ].join('\n'));
}
