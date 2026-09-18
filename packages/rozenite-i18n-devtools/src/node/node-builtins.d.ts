/**
 * Just the slice of Node this package's Metro-side code touches. Declared locally instead
 * of pulling in @types/node, which would put Node globals in scope for the react-native
 * and panel sources too and let a `Buffer` or `process.cwd()` slip into a bundle that has
 * neither.
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isFile(): boolean; isDirectory(): boolean };
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function extname(p: string): string;
  export function basename(p: string, ext?: string): string;
  export function relative(from: string, to: string): string;
  export function resolve(...parts: string[]): string;
  export function isAbsolute(p: string): boolean;
}
