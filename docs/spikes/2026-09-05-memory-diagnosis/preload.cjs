const { appendFileSync } = require('node:fs');
const { PerformanceObserver } = require('node:perf_hooks');
if (process.argv.includes('--persistent')) {
  const output = process.env.STRATA_DIAGNOSTIC_OUTPUT;
  const record = (kind, extra = {}) => appendFileSync(output, JSON.stringify({kind, pid:process.pid, at:Date.now(), ...process.memoryUsage(), ...extra})+'\n');
  record('start');
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) record('gc', {duration:entry.duration, detail:entry.detail});
  });
  observer.observe({entryTypes:['gc']});
  setInterval(() => record('sample'), 100).unref();
  process.on('SIGUSR2', () => {
    const session = new (require('node:inspector').Session)();
    session.connect();
    record('beforeForcedGc');
    session.post('HeapProfiler.collectGarbage', error => {
      record('afterForcedGc', {error:error?.message});
      session.disconnect();
    });
  });
}
