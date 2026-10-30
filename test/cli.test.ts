/**
 * CLI surface tests.
 *
 * The `--count` flag is the acceptance handle for "the tool count equals the
 * live paid-route count", so it is tested against the committed manifest.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST } from '../src/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CLI = resolve(ROOT, 'dist/cli.js');

function run(args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, SYNTHX_PAYER_PRIVATE_KEY: '', SYNTHX_ALLOW_LIVE_SPEND: '' },
  });
}

describe('CLI', () => {
  it('--count prints paid, free and total counts, one per line', () => {
    const out = run(['--count']);
    const lines = out.trim().split('\n').map((l) => Number(l.trim()));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(MANIFEST.paidToolCount);
    expect(lines[1]).toBe(MANIFEST.freeToolCount);
    expect(lines[2]).toBe(MANIFEST.paidToolCount + MANIFEST.freeToolCount);
  });

  it('--list-tools prints a manifest whose tool count matches the paid count', () => {
    const parsed = JSON.parse(run(['--list-tools'])) as {
      paidToolCount: number;
      freeToolCount: number;
      totalToolCount: number;
      tools: unknown[];
    };
    expect(parsed.paidToolCount).toBe(MANIFEST.paidToolCount);
    expect(parsed.freeToolCount).toBe(1);
    expect(parsed.totalToolCount).toBe(MANIFEST.paidToolCount + 1);
    expect(parsed.tools).toHaveLength(MANIFEST.paidToolCount);
  });

  it('--help mentions both transports', () => {
    const out = run(['--help']);
    expect(out).toMatch(/stdio/);
    expect(out).toMatch(/--http/);
    expect(out).toMatch(/--count/);
  });

  it('rejects an unknown flag instead of silently ignoring it', () => {
    let threw = false;
    try {
      run(['--not-a-real-flag']);
    } catch (error) {
      threw = true;
      const stderr = (error as { stderr?: string }).stderr ?? '';
      expect(stderr).toMatch(/Unknown flag/);
    }
    expect(threw).toBe(true);
  });
});
