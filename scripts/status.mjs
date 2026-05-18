const bridgeUrl = 'http://127.0.0.1:7791';

try {
  const response = await fetch(`${bridgeUrl}/api/mvp/status`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  console.log(await response.text());
} catch (error) {
  console.log(`AgentLimb bridge is not online at ${bridgeUrl}. ${error.message}`);
  process.exit(1);
}
