import { describe, expect, it } from 'vitest';
import {
  resolveLexically,
  type LexicalErrorCode,
  type LexicalOptions,
  type LexicalResult,
} from './lexical.ts';

const POSIX_ROOT = '/w/proj';
const WIN_ROOT = 'C:\\w\\proj';

function posix(input: string, extra: Partial<LexicalOptions> = {}): LexicalResult {
  return resolveLexically({ root: POSIX_ROOT, input, platform: 'posix', ...extra });
}

function win(input: string, extra: Partial<LexicalOptions> = {}): LexicalResult {
  return resolveLexically({ root: WIN_ROOT, input, platform: 'win32', ...extra });
}

function segmentsOf(result: LexicalResult): readonly string[] {
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.code}`);
  }
  return result.value.relativeSegments;
}

function codeOf(result: LexicalResult): LexicalErrorCode {
  if (result.ok) {
    throw new Error(`expected an error, got ${result.value.absolute}`);
  }
  return result.code;
}

describe('1. lexical normalization (posix)', () => {
  it.each([
    ['1.1 relative', 'src/a.ts', ['src', 'a.ts']],
    ['1.2 absolute inside', `${POSIX_ROOT}/src/a.ts`, ['src', 'a.ts']],
    ['1.6 dot-dot staying inside', 'src/../src/a.ts', ['src', 'a.ts']],
    ['1.8 dot is the root itself', '.', []],
    ['1.12 double slash and dot segments', 'src//./a.ts', ['src', 'a.ts']],
    ['1.20 tilde is a literal name', '~/x', ['~', 'x']],
    ['1.21 dollar is a literal name', '$HOME/x', ['$HOME', 'x']],
    ['1.21 percent is a literal name', '%USERPROFILE%/x', ['%USERPROFILE%', 'x']],
    ['1.22 file url is a literal relative name', 'file:///etc/passwd', ['file:', 'etc', 'passwd']],
    ['2.10 backslash is a legal posix name', 'a\\b', ['a\\b']],
  ] as const)('%s', (_label, input, expected) => {
    expect(segmentsOf(posix(input))).toEqual(expected);
  });

  it.each([
    ['1.3 absolute outside', '/etc/passwd'],
    ['1.4 dot-dot out', '../outside/x'],
    ['1.5 dot-dot after a segment', 'src/../../outside/x'],
    ['1.18 prefix lookalike root', '/w/proj-evil/x'],
    ['dot-dot to the root parent exactly', '..'],
    ['dot-dot that escapes then re-enters', '../proj/src'],
    ['absolute path that is an ancestor', '/w'],
    ['filesystem root', '/'],
  ] as const)('rejects as outside_root: %s', (_label, input) => {
    expect(codeOf(posix(input))).toBe('outside_root');
  });

  it.each([
    ['1.7 empty', ''],
    ['1.9 NUL inside', 'a\u0000b'],
    ['1.10 trailing NUL', 'a\u0000'],
    ['1.11 newline', 'a\nb'],
    ['1.11 carriage return', 'a\rb'],
    ['1.11 escape', 'a\u001bb'],
    ['1.11 DEL', 'a\u007fb'],
    ['1.11 C1 control (NEL)', 'a\u0085b'],
    ['lone high surrogate', 'a\ud800b'],
    ['lone low surrogate', 'a\udc00b'],
    ['1.15 component over 255 bytes', `${'a'.repeat(256)}/x`],
    ['1.15 multibyte component over 255 bytes', `${'é'.repeat(128)}/x`],
    ['1.14 path over 4096 bytes', `${'a/'.repeat(2049)}x`],
  ] as const)('rejects as invalid_path: %s', (_label, input) => {
    expect(codeOf(posix(input))).toBe('invalid_path');
  });

  it('accepts a component of exactly 255 bytes', () => {
    expect(segmentsOf(posix(`${'a'.repeat(255)}/x`))).toEqual(['a'.repeat(255), 'x']);
  });

  it('1.13 reports a trailing slash instead of deciding what it means', () => {
    const result = posix('src/');
    expect(result.ok && result.value.trailingSlash).toBe(true);
    const plain = posix('src');
    expect(plain.ok && plain.value.trailingSlash).toBe(false);
  });

  it('1.19 treats a root with a trailing slash like one without', () => {
    const withSlash = resolveLexically({
      root: `${POSIX_ROOT}/`,
      input: 'src/a.ts',
      platform: 'posix',
    });
    expect(segmentsOf(withSlash)).toEqual(['src', 'a.ts']);
  });

  it('builds the absolute path from the root and the normalized segments', () => {
    const result = posix('src//./a.ts');
    expect(result.ok && result.value.absolute).toBe('/w/proj/src/a.ts');
    const root = posix('.');
    expect(root.ok && root.value.absolute).toBe('/w/proj');
    expect(root.ok && root.value.isRoot).toBe(true);
  });

  it('1.18 a root that is a prefix of a longer sibling name does not contain it', () => {
    expect(codeOf(posix('/w/proj2/x'))).toBe('outside_root');
  });

  it('never echoes the input in an error', () => {
    const result = posix('../secret-token-123');
    expect(JSON.stringify(result)).not.toContain('secret-token-123');
  });

  it('treats a leading double slash as a single slash', () => {
    expect(segmentsOf(posix('//w/proj/x'))).toEqual(['x']);
  });
});

describe('1.17 / 4.1 case and Unicode folding is only a pre-filter on case-insensitive volumes', () => {
  it('rejects a differently-cased root on a case-sensitive volume', () => {
    const result = resolveLexically({
      root: '/Users/a/Proj',
      input: '/users/a/proj/x',
      platform: 'posix',
    });
    expect(codeOf(result)).toBe('outside_root');
  });

  it('accepts a differently-cased root when the volume is case-insensitive', () => {
    const result = resolveLexically({
      root: '/Users/a/Proj',
      input: '/users/a/proj/x',
      platform: 'posix',
      caseInsensitive: true,
    });
    expect(segmentsOf(result)).toEqual(['x']);
  });

  it('treats NFC and NFD spellings as the same name only when case-insensitive', () => {
    const nfc = '\u00e9';
    const nfd = 'e\u0301';
    const root = `/w/${nfc}`;
    const input = `/w/${nfd}/x`;
    expect(codeOf(resolveLexically({ root, input, platform: 'posix' }))).toBe('outside_root');
    expect(
      segmentsOf(resolveLexically({ root, input, platform: 'posix', caseInsensitive: true })),
    ).toEqual(['x']);
  });

  it('keeps the input spelling in the returned segments', () => {
    const result = resolveLexically({
      root: '/Users/a/Proj',
      input: 'Src/A.ts',
      platform: 'posix',
      caseInsensitive: true,
    });
    expect(segmentsOf(result)).toEqual(['Src', 'A.ts']);
  });
});

describe('2. Windows and UNC forms (tested lexically on every host)', () => {
  it.each([
    ['2.9 backslashes', 'src\\a.ts', ['src', 'a.ts']],
    ['2.9 mixed slashes', 'src/sub\\a.ts', ['src', 'sub', 'a.ts']],
    ['absolute inside with a drive', 'C:\\w\\proj\\src\\a.ts', ['src', 'a.ts']],
    ['absolute inside, drive letter case', 'c:/w/proj/src', ['src']],
    ['dot-dot staying inside', 'src\\..\\src\\a.ts', ['src', 'a.ts']],
    ['a name that merely starts like a device', 'console.ts', ['console.ts']],
    ['a name with a dot in the middle', 'a.b.c', ['a.b.c']],
  ] as const)('%s', (_label, input, expected) => {
    expect(segmentsOf(win(input))).toEqual(expected);
  });

  it.each([
    ['2.1 UNC share', '\\\\server\\share\\x'],
    ['2.1 UNC with forward slashes', '//server/share/x'],
    ['2.2 verbatim prefix', '\\\\?\\C:\\x'],
    ['2.2 device prefix', '\\\\.\\C:\\x'],
    ['2.2 verbatim with forward slashes', '//?/C:/x'],
    ['2.4 drive-relative', 'C:x'],
    ['rooted without a drive', '\\x'],
    ['rooted without a drive, forward slash', '/x'],
  ] as const)('rejects as unsupported_path_form: %s', (_label, input) => {
    expect(codeOf(win(input))).toBe('unsupported_path_form');
  });

  it('2.3 rejects a path on another drive as outside_root', () => {
    expect(codeOf(win('D:\\outside\\x'))).toBe('outside_root');
    expect(codeOf(win('C:\\w\\other\\x'))).toBe('outside_root');
  });

  it.each([
    ['2.5 CON', 'CON'],
    ['2.5 lowercase nul', 'nul'],
    ['2.5 COM1', 'COM1'],
    ['2.5 LPT9', 'lpt9'],
    ['2.5 aux with an extension', 'aux.txt'],
    ['2.5 reserved name in the middle', 'src\\PRN\\x'],
    ['2.5 reserved name with trailing dot', 'CON.'],
    ['2.6 trailing dot', 'a.'],
    ['2.6 trailing space', 'a '],
    ['2.7 alternate data stream', 'a.txt:stream'],
    ['illegal character <', 'a<b'],
    ['illegal character >', 'a>b'],
    ['illegal character "', 'a"b'],
    ['illegal character |', 'a|b'],
    ['illegal character ?', 'a?b'],
    ['illegal character *', 'a*b'],
    ['1.14 over 32767 characters', `${'a/'.repeat(16400)}x`],
  ] as const)('rejects as invalid_path: %s', (_label, input) => {
    expect(codeOf(win(input))).toBe('invalid_path');
  });

  it('applies the posix rules for a posix platform even with windows-looking text', () => {
    expect(segmentsOf(posix('C:x/CON'))).toEqual(['C:x', 'CON']);
    expect(segmentsOf(posix('a.txt:stream'))).toEqual(['a.txt:stream']);
  });

  it('builds a windows absolute path with the drive and backslashes', () => {
    const result = win('src/a.ts');
    expect(result.ok && result.value.absolute).toBe('C:\\w\\proj\\src\\a.ts');
  });

  it('compares the drive and the segments case-insensitively on win32 by default', () => {
    expect(segmentsOf(win('c:\\W\\PROJ\\x'))).toEqual(['x']);
  });
});

describe('root validation is a programmer error', () => {
  it('throws for a relative posix root', () => {
    expect(() => resolveLexically({ root: 'proj', input: 'a', platform: 'posix' })).toThrow(
      TypeError,
    );
  });

  it('throws for a win32 root without a drive', () => {
    expect(() => resolveLexically({ root: '\\proj', input: 'a', platform: 'win32' })).toThrow(
      TypeError,
    );
  });

  it('throws for a root containing dot-dot', () => {
    expect(() => resolveLexically({ root: '/w/../proj', input: 'a', platform: 'posix' })).toThrow(
      TypeError,
    );
  });
});

describe('8.5 the decision is stable under redundant separators', () => {
  const inputs = ['src/a.ts', '../x', 'a/../..', '.', 'src/../src', '/etc/passwd', '/w/proj/ok'];

  it.each(inputs)('%s', (input) => {
    const noisy = input
      .split('/')
      .map((part) => (part === '' ? part : `./${part}`))
      .join('//');
    const plain = posix(input);
    const redundant = posix(noisy);
    expect(redundant.ok).toBe(plain.ok);
    if (plain.ok && redundant.ok) {
      expect(redundant.value.absolute).toBe(plain.value.absolute);
    }
  });
});
