declare module 'solc' {
  const compiler: { compile(input: string, callbacks?: { import: (path: string) => { contents?: string; error?: string } }): string; version(): string };
  export default compiler;
}
