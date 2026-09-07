// Real public navigation audits. No blocked URLs, skipped audits or score overrides.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const origin = new URL(process.argv[2] || 'https://geospatial-platform.diegoromero.es').origin;
const runs = Number(process.argv[3] || 3);
if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Error('Runs must be an integer from 1 to 5');
const output = resolve('tmp/lighthouse/final');
await mkdir(output, { recursive: true });
const records = [];
for (const [page, path] of [['home', '/'], ['map', '/mapa/']]) {
  for (const device of ['mobile', 'desktop']) {
    for (let run = 1; run <= runs; run++) {
      const report = `${output}/${page}-${device}-${run}`;
      const args = ['--yes', 'lighthouse@13.4.1', origin + path,
        '--chrome-flags=--headless=new', '--only-categories=performance,accessibility,best-practices,seo',
        '--output=json', '--output=html', `--output-path=${report}`, '--quiet'];
      if (device === 'desktop') args.push('--preset=desktop');
      const execution = spawnSync('npx', args, { stdio: 'inherit' });
      if (execution.status !== 0) throw new Error(`Lighthouse failed for ${page}/${device}/${run}`);
      const result = JSON.parse(await readFile(`${report}.report.json`, 'utf8'));
      if (result.runtimeError) throw new Error(JSON.stringify(result.runtimeError));
      const scores = Object.fromEntries(Object.entries(result.categories).map(([key, value]) => [key, value.score * 100]));
      const metrics = Object.fromEntries(['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index']
        .map(key => [key, result.audits[key].numericValue]));
      records.push({ page, device, run, url: result.finalDisplayedUrl, version: result.lighthouseVersion,
        fetchedAt: result.fetchTime, scores, metrics, report: `${report}.report.html` });
      console.log(JSON.stringify({ page, device, run, scores }));
      await writeFile(`${output}/summary.json`, JSON.stringify(records, null, 2) + '\n');
    }
  }
}
const passed = records.every(record => Object.values(record.scores).every(score => score > 95));
console.log(passed ? 'PASS: every category exceeds 95 in every run.' : 'FAIL: at least one category does not exceed 95. Inspect the saved reports.');
process.exitCode = passed ? 0 : 1;
