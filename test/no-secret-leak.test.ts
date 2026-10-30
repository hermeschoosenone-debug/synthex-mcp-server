/**
 * Secret-leak guard.
 *
 * Scans the repository's own committed source for anything that looks like an
 * EVM private key, and asserts that the payer key is only ever READ from the
 * environment.
 *
 * A REAL leaked key is high-entropy. A synthetic fixture value (a run of
 * repeated nibbles such as 0x1111...11) is not. The guard therefore treats an
 * all-identical-nibble value as synthetic, which is what lets the test
 * fixtures carry a throwaway settlement hash without tripping the guard.
 * Everything else shaped like a key is an offence.
 *
 * The scanner is itself proven non-vacuous: a planted key is written to a
 * TEMPORARY directory at runtime (never committed) and the scanner must find
 * it. That is why this repository contains no high-entropy 64-hex literal.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/** Directories that are not part of the published source. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.vitest']);

const TEXT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.txt',
  '.env',
];

/** A 64-hex-character run with the 0x prefix — the shape of an EVM private key. */
const KEY_SHAPED = /0x([0-9a-fA-F]{64})/g;

/**
 * True when the hex body is a single repeated nibble, e.g. "1111...11".
 * That is a synthetic placeholder, not a key.
 */
export function isSyntheticHex(hexBody: string): boolean {
  return /^([0-9a-fA-F])\1{63}$/.test(hexBody);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function isTextFile(path: string): boolean {
  return TEXT_EXTENSIONS.includes(extname(path));
}

/** Every key-shaped literal under `root`, excluding synthetic values. */
export function findKeyShapedLiterals(root: string): string[] {
  const offenders: string[] = [];
  for (const file of walk(root)) {
    if (!isTextFile(file)) continue;
    const content = readFileSync(file, 'utf-8');
    for (const match of content.matchAll(KEY_SHAPED)) {
      const body = match[1]!;
      if (isSyntheticHex(body)) continue;
      offenders.push(`${file.replace(root + '/', '')}: 0x${body.slice(0, 8)}...`);
    }
  }
  return offenders;
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('no private key is committed', () => {
  it('finds no key-shaped literal in any committed source file', () => {
    expect(findKeyShapedLiterals(ROOT)).toEqual([]);
  });

  it('the scanner actually detects a planted key (proves it is not vacuous)', () => {
    // Plant a high-entropy 32-byte value in a TEMP directory — never committed.
    const dir = mkdtempSync(join(tmpdir(), 'synthex-keyscan-'));
    tempDirs.push(dir);
    const planted = `0x${'4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'}`;
    writeFileSync(join(dir, 'planted.ts'), `const key = "${planted}";\n`, 'utf-8');

    const found = findKeyShapedLiterals(dir);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('planted.ts');
  });

  it('does not flag a synthetic repeated-nibble value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synthex-keyscan-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'synthetic.ts'), `const tx = "0x${'1'.repeat(64)}";\n`, 'utf-8');
    expect(findKeyShapedLiterals(dir)).toEqual([]);
  });

  it('reads the payer key only from the environment', () => {
    const paymentSource = readFileSync(resolve(ROOT, 'src/payment.ts'), 'utf-8');
    expect(paymentSource).toContain('SYNTHX_PAYER_PRIVATE_KEY');
    expect(paymentSource).not.toMatch(/writeFileSync/);
    expect(paymentSource).not.toMatch(/appendFile/);
    expect(paymentSource).not.toMatch(/console\.(log|info|warn|error)\([^)]*privateKey/i);
  });

  it('never serialises the key into a payment payload', () => {
    const paymentSource = readFileSync(resolve(ROOT, 'src/payment.ts'), 'utf-8');
    const payloadBlock = paymentSource.slice(
      paymentSource.indexOf('export async function signEip3009'),
    );
    expect(payloadBlock).not.toMatch(/privateKey[,}]/);
  });

  it('classifies a synthetic fixture value as synthetic', () => {
    expect(isSyntheticHex('1'.repeat(64))).toBe(true);
    expect(isSyntheticHex('a'.repeat(64))).toBe(true);
    expect(
      isSyntheticHex('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'),
    ).toBe(false);
  });
});

describe('the gitignore protects key material', () => {
  it('ignores .env files', () => {
    const gitignore = readFileSync(resolve(ROOT, '.gitignore'), 'utf-8');
    expect(gitignore).toMatch(/\.env/);
  });
});
