declare module '*/camotics.js' {
  const factory: (opts?: { locateFile?: (p: string) => string }) => Promise<any>;
  export default factory;
}
