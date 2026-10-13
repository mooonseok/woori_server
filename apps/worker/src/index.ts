// Bootstrap only: no queue is consumed and no external services are contacted.
console.info(JSON.stringify({ service: "woori-worker", state: "bootstrap", processingEnabled: false }));

if (!process.argv.includes("--check")) {
  const keepAlive = setInterval(() => {}, 60_000);
  const shutdown = () => {
    clearInterval(keepAlive);
    console.info(JSON.stringify({ service: "woori-worker", state: "stopped" }));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
